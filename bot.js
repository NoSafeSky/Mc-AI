const fs = require("fs");
const path = require("path");
const mineflayer = require("mineflayer");
const { pathfinder, Movements } = require("mineflayer-pathfinder");
const { plugin: collectBlockPlugin } = require("mineflayer-collectblock");

const { parseNLU } = require("./brain/nlu");
const { planAndRun } = require("./brain/planner");
const { startAutonomy } = require("./brain/autonomy");

const cfg = JSON.parse(fs.readFileSync("./config.json", "utf8"));

const memoryDir = path.join(__dirname, "memory");
if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });

const statePath = path.join(memoryDir, "state.json");
const logPath = path.join(memoryDir, "log.jsonl");

const { llmParseIntent } = require("./brain/llm_nlu");
const { llmChatReply } = require("./brain/llm_chat");


function loadState() {
  if (!fs.existsSync(statePath)) {
    const init = { creepy: !!cfg.creepy, stopped: false, base: null, doNotTouch: [] };
    fs.writeFileSync(statePath, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}
function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}
function log(evt) {
  fs.appendFileSync(logPath, JSON.stringify({ t: Date.now(), ...evt }) + "\n");
}

let state = loadState();
let lastChatAt = 0;
const recentMessages = new Map();
const DUP_WINDOW_MS = 3000;
const pendingSystem = new Map();
let lastReplyAt = 0;
const chatMemory = new Map();
const chatMemorySize = cfg.chatMemorySize || 6;
const recentRawSpawns = [];

function normalizeMessage(message) {
  // remove formatted prefixes like "<Name> "
  if (!message) return "";
  return String(message).replace(/^<[^>]+>\s*/i, "").trim();
}

const bot = mineflayer.createBot({
  host: cfg.host,
  port: cfg.port,
  username: cfg.username,
  version: cfg.version,
  viewDistance: cfg.viewDistance || 10
});


bot.loadPlugin(pathfinder);
bot.loadPlugin(collectBlockPlugin);

// Increase pathfinder stuck timeout to 60s
bot.on("spawn", () => {
  if (bot.pathfinder) {
    bot.pathfinder.stuckTimeout = 60000;
  }
});

bot.once("spawn", () => {
  bot.chat("...");
  log({ type: "spawn" });
  bot.addChatPattern(
    "simple",
    /^<([^>]+)>\s+(.*)$/,
    { parse: true }
  );
  const mcData = require("minecraft-data")(bot.version);
  const baseMovements = new Movements(bot, mcData);
  baseMovements.allow1by1towers = true; // allow pillaring everywhere
  baseMovements.allowParkour = false;
  baseMovements.canDig = false; // avoid mining during general movement
  bot.pathfinder.setMovements(baseMovements);
  startAutonomy(bot, () => state, (s) => { state = s; saveState(state); }, log, cfg);
});

async function handleChat(username, message, source = "chat") {
  if (username === bot.username) return;

  const now = Date.now();
  const clean = normalizeMessage(message).toLowerCase();
  const key = `${username}|${clean}`;
  const last = recentMessages.get(key) || 0;
  if (now - last < DUP_WINDOW_MS) return;
  recentMessages.set(key, now);
  // cleanup
  for (const [k, t] of recentMessages.entries()) {
    if (now - t > DUP_WINDOW_MS) recentMessages.delete(k);
  }

  log({ type: "chat_in", from: username, message: clean, source });

  const lower = clean.toLowerCase().trim();

  // HARD kill-switch
  if (lower.includes("!stopall")) {
    state.stopped = true;
    saveState(state);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    bot.chat("ok.");
    log({ type: "stopall", by: username });
    return;
  }

  // Owner can resume
  if (state.stopped && username === cfg.owner && lower.includes("resume")) {
    state.stopped = false;
    saveState(state);
    bot.chat("resumed.");
    log({ type: "resume", by: username });
    return;
  }

  if (state.stopped) return;

  // Process all chat messages (whitelist controls access)
  const isOwner = username === cfg.owner;
  const prefix = cfg.commandPrefix || "bot,";
  const hasPrefix = isOwner && lower.startsWith(prefix);
  const stripped = hasPrefix ? clean.slice(prefix.length).trim() : clean;
  const looksLikeCommand = hasPrefix;
  const explicitFollow = /^(follow me|come here|come to me)\b/i.test(lower);

  // Owner toggle for goal autonomy
  if (isOwner) {
    if (lower.includes("goal off")) { state.goalAutonomy = false; saveState(state); bot.chat("goal off"); return; }
    if (lower.includes("goal on")) { state.goalAutonomy = true; saveState(state); bot.chat("goal on"); return; }
  }

  if (lower.includes("!llm test")) {
    const reply = await llmChatReply("say hello", cfg);
    if (reply) bot.chat(reply);
    return;
  }

  if (isOwner && lower === `${cfg.commandPrefix} entities`) {
    const list = Object.values(bot.entities)
      .filter((e) => e.type === "mob")
      .map((e) => String(e.displayName || e.name || "").toLowerCase())
      .slice(0, 10);
    bot.chat(`mobs: ${list.length ? list.join(", ") : "none"}`);
    log({ type: "entities_debug", count: Object.keys(bot.entities).length, mobs: list });
    return;
  }

  if (isOwner && lower === `${cfg.commandPrefix} where`) {
    const pos = bot.entity?.position;
    if (pos) bot.chat(`pos: ${pos.x.toFixed(1)} ${pos.y.toFixed(1)} ${pos.z.toFixed(1)}`);
    log({ type: "where", pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : null });
    return;
  }

  if (isOwner && lower === `${cfg.commandPrefix} dist`) {
    const owner = bot.players[cfg.owner]?.entity;
    if (owner) {
      const dist = bot.entity.position.distanceTo(owner.position);
      bot.chat(`dist: ${dist.toFixed(1)}`);
      log({ type: "dist", dist });
    }
    return;
  }

  if (isOwner && lower === `${cfg.commandPrefix} rawtypes`) {
    const last = recentRawSpawns.slice(-10);
    const line = last.map((e) => `${e.rawType}@${Math.round(e.x)},${Math.round(e.y)},${Math.round(e.z)}`).join(" | ");
    bot.chat(line || "no rawtypes yet");
    log({ type: "rawtypes", entries: last });
    return;
  }


  let intent = null;

  // Try LLM for any message (whitelist handles access)
  if (looksLikeCommand) {
    try {
      log({ type: "llm_use", msg: stripped });
      intent = { type: "freeform", message: stripped };
    } catch (e) {
      log({ type: "llm_fail", msg: message, err: String(e) });
      intent = null; // will fallback
    }
  }

  if (!intent || intent.type === "none") {
    intent = parseNLU(message, cfg);
  }

  if ((intent?.type === "follow" || intent?.type === "come") && !explicitFollow) {
    intent = { type: "none" };
  }

  const taskLike = /(seek|find|explore|craft|build|mine|harvest|gather|kill|attack|get|bring|collect|hunt)/i.test(lower);
  if (!intent || intent.type === "none") {
    if (taskLike && hasPrefix) {
      intent = { type: "freeform", message: stripped };
    }
  }

  if (!intent || intent.type === "none") {
    if (cfg.chatEnabled) {
      const now = Date.now();
      if (now - lastChatAt > (cfg.chatCooldownMs || 10000) && now - lastReplyAt > (cfg.chatCooldownMs || 10000)) {
        const mem = chatMemory.get(username) || [];
        mem.push({ role: "user", text: clean });
        const reply = await llmChatReply(message, cfg, mem);
        if (reply) {
          bot.chat(reply);
          lastChatAt = now;
          lastReplyAt = now;
          mem.push({ role: "bot", text: reply });
          while (mem.length > chatMemorySize) mem.shift();
          chatMemory.set(username, mem);
          log({ type: "chat_reply", to: username, reply });
        }
      }
    }
    return;
  }

  // All players can control (whitelist enforced server-side)

  log({ type: "intent", from: username, message, intent, explicitFollow, taskLike });

  try {
    await planAndRun(bot, intent, () => state, (s) => { state = s; saveState(state); }, log, cfg);
  } catch (e) {
    bot.chat("can't.");
    log({ type: "error", where: "planAndRun", e: String(e) });
  }
}

bot.on("chat", (username, message) => {
  handleChat(username, message, "chat");
});

// Disable chat_pattern handler (it produces malformed username arrays on this server)
// bot.on("chat:simple", (username, message) => {
//   handleChat(username, message, "chat_pattern");
// });

// Disable messagestr to avoid duplicate replies
// bot.on("messagestr", (message) => {});

bot.on("whisper", (username, message) => {
  handleChat(username, message, "whisper");
});

bot.on("kicked", (reason) => console.log("KICKED:", reason));
bot.on("error", (err) => console.log("ERROR:", err));

bot.on("entitySpawn", (entity) => {
  if (entity?.type === "mob") {
    log({ type: "entity_spawn", name: entity.displayName || entity.name, id: entity.id });
  }
});

// Low-level packet logging to confirm if entity packets are arriving
bot._client.on("entity_destroy", (packet) => {
  log({ type: "packet_entity_destroy", ids: packet?.entityIds || [] });
});

bot._client.on("spawn_entity", (packet) => {
  try {
    const mcData = require("minecraft-data")(bot.version);
    const mapped = mcData.entitiesById?.[packet?.type] || null;
    recentRawSpawns.push({ entityId: packet?.entityId, rawType: packet?.type, x: packet?.x, y: packet?.y, z: packet?.z, t: Date.now(), mapped: mapped?.name || null });
    if (recentRawSpawns.length > 50) recentRawSpawns.shift();
    log({
      event: "packet_spawn_entity",
      entityId: packet?.entityId,
      rawType: packet?.type,
      mappedName: mapped?.name || null,
      x: packet?.x,
      y: packet?.y,
      z: packet?.z
    });
  } catch (e) {
    log({ event: "packet_spawn_entity", entityId: packet?.entityId, rawType: packet?.type, error: String(e) });
  }
});

bot._client.on("spawn_entity_living", (packet) => {
  try {
    const mcData = require("minecraft-data")(bot.version);
    const mapped = mcData.entitiesById?.[packet?.type] || null;
    log({
      event: "packet_spawn_entity_living",
      entityId: packet?.entityId,
      rawType: packet?.type,
      mappedName: mapped?.name || null,
      x: packet?.x,
      y: packet?.y,
      z: packet?.z
    });
  } catch (e) {
    log({ event: "packet_spawn_entity_living", entityId: packet?.entityId, rawType: packet?.type, error: String(e) });
  }
});
