const fs = require("fs");
const path = require("path");
const mineflayer = require("mineflayer");
const { pathfinder, Movements } = require("mineflayer-pathfinder");
const { plugin: collectBlockPlugin } = require("mineflayer-collectblock");

const { planAndRun } = require("./brain/planner");
const { startAutonomy } = require("./brain/autonomy");
const { isLivingNonPlayerEntity, getCanonicalEntityName } = require("./brain/entities");
const { buildGoalPlan } = require("./brain/dependency_planner");
const { routePromptWithLLM, getLastRouteFailure } = require("./brain/llm_router");
const { compileGoalSpecsToIntents } = require("./brain/goal_compiler");

const cfg = Object.assign(
  {
    commandPrefix: "bot",
    commandNoPrefixOwner: true,
    intentConfidenceThreshold: 0.72,
    llmPrimaryRouting: true,
    llmRouteAllOwnerPrompts: true,
    llmRouteNonOwnerChat: true,
    llmPlanMode: "high_level_goals",
    llmActionMinConfidence: 0.7,
    llmChatMinConfidence: 0.55,
    llmPlanMaxGoals: 5,
    llmRequireStrictJson: true,
    llmPlanTimeoutMs: 8000,
    structuredAck: true,
    taskTimeoutSec: 60,
    taskNoProgressTimeoutSec: 45,
    taskProgressHeartbeatSec: 3,
    maxTaskDistance: 32,
    noTargetTimeoutSec: 8,
    craftJobTimeoutSec: 90,
    craftGatherRadius: 48,
    craftAutoPlaceTable: true,
    craftDefaultCount: 1,
    cancelOnNewCommand: false,
    reasoningEnabled: true,
    reasoningPlacementRings: [4, 8, 12],
    reasoningMaxCorrectionsPerStep: 6,
    reasoningCandidateLimit: 24,
    reasoningEntityClearance: 1.2,
    reasoningMoveTimeoutMs: 12000,
    intelligenceEnabled: true,
    intelligenceDomains: ["craft", "move", "combat", "explore", "follow"],
    dependencyPlannerEnabled: true,
    dependencyMaxDepth: 10,
    dependencyMaxNodes: 1200,
    dependencyPlanTimeoutMs: 8000,
    supportedStations: ["inventory", "crafting_table", "furnace", "smoker", "blast_furnace", "stonecutter", "smithing_table"],
    recipeExecutionScope: "craft_smelt_stations",
    stationExecutionEnabled: ["inventory", "crafting_table", "furnace", "smoker", "blast_furnace", "stonecutter", "smithing_table"],
    fuelPolicy: "inventory_first_then_charcoal_then_coal",
    recipePlannerBeamWidth: 24,
    recipeVariantCapPerItem: 32,
    autoGatherEnabled: true,
    autoGatherRadius: 48,
    gatherBlockSampleCount: 128,
    gatherTargetCandidates: 6,
    gatherTargetFailLimit: 2,
    gatherRadiusSteps: [24, 48, 72],
    gatherStepTimeoutSec: 12000,
    gatherExpandRetryPerRing: 2,
    autoGatherTimeoutSec: 90,
    replanOnRecoverableFail: true,
    maxReplansPerGoal: 3,
    reasoningStepTimeoutMs: 12000,
    commandAckTimeoutMs: 1000,
    chatReplyMode: "short",
    chatReplyTimeoutMs: 30000,
    recipeQuestionMode: "deterministic",
    recipeQuestionNoAction: true,
    recipeVariantPolicy: "overworld_safe",
    materialFlexPolicy: "inventory_first_any_wood",
    preferBambooForSticks: false,
    strictHarvestToolGate: true,
    autoAcquireRequiredTools: true,
    missingResourcePolicy: "auto_relocate",
    missingResourceAutoRings: [120, 192, 256],
    missingResourceMaxRelocations: 3,
    missingResourceRelocateTimeoutSec: 45,
    missingResourceConfirmTimeoutSec: 12,
    missingResourceExpandedRadius: 120,
    dynamicMoveTimeoutBaseMs: 12000,
    dynamicMoveTimeoutPerBlockMs: 180,
    ollamaDisableThinking: true,
    ollamaRequestMode: "stable",
    logReasonerCandidateRejects: false,
    logReasonerRejectSummaryEverySec: 5,
    logCompactMode: true,
    logMuteEvents: [],
    logMobSpawns: false,
    logEntityPackets: false
  },
  JSON.parse(fs.readFileSync("./config.json", "utf8"))
);

const memoryDir = path.join(__dirname, "memory");
if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });

const statePath = path.join(memoryDir, "state.json");
const logPath = path.join(memoryDir, "log.jsonl");

const { inventoryCount } = require("./brain/craft_executor");


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

const DEFAULT_MUTED_LOG_TYPES = new Set([
  "task_progress",
  "step_progress",
  "need_acquire_start",
  "need_acquire_ok",
  "reasoner_try",
  "reasoner_reject_summary"
]);

const configuredMutedTypes = new Set(
  Array.isArray(cfg.logMuteEvents)
    ? cfg.logMuteEvents.map((x) => String(x || "").trim()).filter(Boolean)
    : []
);

function shouldPersistLog(evt) {
  if (!evt || typeof evt !== "object") return false;
  const t = String(evt.type || evt.event || "").trim();
  if (!t) return true;
  if (configuredMutedTypes.has(t)) return false;
  if (cfg.logCompactMode !== false && DEFAULT_MUTED_LOG_TYPES.has(t)) return false;
  return true;
}

function log(evt) {
  if (!shouldPersistLog(evt)) return;
  fs.appendFileSync(logPath, JSON.stringify({ t: Date.now(), ...evt }) + "\n");
}

function logLlmFailureSignal(provider, failure, extra = {}) {
  if (!failure?.reason) return;
  const base = {
    provider: provider || cfg.llmProvider || "unknown",
    reasonCode: failure.reason,
    ...extra
  };
  if (failure.status !== undefined) base.status = failure.status;
  if (failure.error) base.error = failure.error;

  if (failure.reason === "llm_empty_response") {
    log({ type: "llm_empty_response", ...base });
    return;
  }
  if (failure.reason === "llm_thinking_only_response") {
    log({ type: "llm_thinking_only_response", hasThinking: !!failure.hasThinking, ...base });
    return;
  }
  if (failure.reason === "llm_provider_unreachable") {
    log({ type: "llm_provider_unreachable", ...base });
  }
}

let state = loadState();
const recentMessages = new Map();
const DUP_WINDOW_MS = 3000;
const chatMemory = new Map();
const chatMemorySize = cfg.chatMemorySize || 6;
const recentRawSpawns = [];
let taskSeq = 0;
let activeTask = null;
let entitiesByInternalId = null;
let lastGoalPreview = null;
let lastTaskFailure = null;
let pendingDecision = null;
let pendingDecisionTimer = null;

function normalizeMessage(message) {
  // remove formatted prefixes like "<Name> "
  if (!message) return "";
  return String(message).replace(/^<[^>]+>\s*/i, "").trim();
}

function hasCommandPrefix(text, prefix) {
  if (!prefix) return false;
  const p = String(prefix).toLowerCase().trim();
  const t = String(text || "").toLowerCase().trim();
  return t === p || t.startsWith(`${p} `);
}

function stripCommandPrefix(text, prefix) {
  const p = String(prefix).trim();
  const t = String(text || "").trim();
  if (!p) return t;
  if (t.toLowerCase() === p.toLowerCase()) return "";
  if (t.toLowerCase().startsWith(`${p.toLowerCase()} `)) {
    return t.slice(p.length).trim();
  }
  return t;
}

function looksActionable(text) {
  const t = String(text || "").toLowerCase();
  return /\b(kill|attack|hunt|slay|follow|come|stop|resume|harvest|chop|craft|explore|seek|find|collect|gather|build|mine|bring)\b/.test(t);
}

function isActionableIntent(intent) {
  if (!intent || intent.type === "none") return false;
  return true;
}

function isStopIntent(intent) {
  const type = String(intent?.type || "").toLowerCase();
  return type === "stop" || type === "stopall";
}

function intentSummary(intent) {
  const source = intent.source || "rules";
  if (intent.type === "attackMob" && intent.mobType) return `intent: attackMob ${intent.mobType} (${source})`;
  if (intent.type === "craftItem" && intent.item) {
    const needs = Array.isArray(intent.previewNeeds) && intent.previewNeeds.length
      ? ` | needs: ${intent.previewNeeds.slice(0, 4).map((n) => n.item ? `${n.item} x${n.count}` : `station:${n.station}`).join(", ")}`
      : "";
    return `intent: craftItem ${intent.item} x${intent.count || 1} (${source})${needs}`;
  }
  return `intent: ${intent.type} (${source})`;
}

function summarizeGoal(goal) {
  if (!goal || typeof goal !== "object") return "unknown";
  const type = String(goal.type || "unknown");
  const args = goal.args && typeof goal.args === "object" ? goal.args : {};
  if (type === "craftItem") return `craftItem:${args.item || "?"}x${args.count || 1}`;
  if (type === "attackMob") return `attackMob:${args.mobType || "?"}`;
  if (type === "explore") return `explore:r${args.radius || "?"}/s${args.seconds || "?"}`;
  if (type === "follow" || type === "come") return `${type}:${args.target || "owner"}`;
  return type;
}

function summarizeIntent(intent) {
  if (!intent || typeof intent !== "object") return "unknown";
  if (intent.type === "craftItem") return `craftItem:${intent.item || "?"}x${intent.count || 1}`;
  if (intent.type === "attackMob") return `attackMob:${intent.mobType || "?"}`;
  if (intent.type === "explore") return `explore:r${intent.radius || "?"}/s${intent.seconds || "?"}`;
  if (intent.type === "follow" || intent.type === "come") return `${intent.type}:${intent.target || "owner"}`;
  return intent.type || "unknown";
}

function clearPendingDecision() {
  if (pendingDecisionTimer) {
    clearTimeout(pendingDecisionTimer);
    pendingDecisionTimer = null;
  }
  pendingDecision = null;
}

function isYesReply(text) {
  return /^(yes|y|ok|okay|sure|continue|expand|go)$/i.test(String(text || "").trim());
}

function isNoReply(text) {
  return /^(no|n|cancel|stop|dont|don't)$/i.test(String(text || "").trim());
}

function schedulePendingDecisionTimeout() {
  if (!pendingDecision) return;
  if (pendingDecisionTimer) clearTimeout(pendingDecisionTimer);
  const delay = Math.max(1, pendingDecision.expiresAt - Date.now());
  pendingDecisionTimer = setTimeout(() => {
    if (!pendingDecision) return;
    if (Date.now() < pendingDecision.expiresAt) return;
    const expired = pendingDecision;
    clearPendingDecision();
    log({
      type: "confirm_expand_search_timeout",
      taskId: expired.taskId,
      goalId: expired.goalId || null,
      item: expired.item,
      fromRadius: expired.fromRadius,
      toRadius: expired.toRadius
    });
    bot.chat(`can't: search confirmation timed out for ${expired.item}`);
  }, delay);
}

function ensureEntityTypeMap(botRef) {
  if (entitiesByInternalId) return entitiesByInternalId;
  const list = botRef.registry?.entitiesArray || [];
  entitiesByInternalId = new Map(list.map((e) => [e.internalId, e]));
  return entitiesByInternalId;
}

function mapRawEntityType(botRef, rawType) {
  const map = ensureEntityTypeMap(botRef);
  return map.get(rawType) || null;
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
  ensureEntityTypeMap(bot);
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

function updateChatMemory(username, role, text) {
  if (!username) return;
  const content = String(text || "").trim();
  if (!content) return;
  const mem = chatMemory.get(username) || [];
  mem.push({ role, text: content });
  while (mem.length > chatMemorySize) mem.shift();
  chatMemory.set(username, mem);
}

function routeRejectMessage(reasonCode) {
  const code = String(reasonCode || "unsupported_request").toLowerCase();
  if (code.includes("unsafe")) return "can't: unsafe request";
  if (code.includes("unknown_craft_target")) return "can't: unknown craft target";
  if (code.includes("unknown_target")) return "can't: unknown target";
  if (code.includes("too_many_goals")) return "can't: request too broad";
  return "can't: unsupported request";
}

function previewCraftIntent(intent, username, text) {
  if (!isActionableIntent(intent)) return intent;
  if (
    intent.type !== "craftItem" ||
    cfg.intelligenceEnabled === false ||
    cfg.dependencyPlannerEnabled === false
  ) {
    return intent;
  }

  const preview = buildGoalPlan(bot, intent, cfg, null, () => {});
  if (!preview?.ok) {
    const reason = preview?.code || "unsupported_craft_target";
    const rejected = {
      type: "none",
      source: intent.source || "llm",
      confidence: 0,
      reason: reason === "unknown_craft_target" ? "unknown_craft_target" : "unsupported_craft_target",
      plannerCode: preview?.code || null,
      requested: intent.item || null
    };
    log({
      type: "intent_reject",
      from: username,
      reason: rejected.reason,
      plannerCode: preview?.code || null,
      plannerReason: preview?.reason || null,
      nextNeed: preview?.nextNeed || null,
      requested: rejected.requested,
      text
    });
    return rejected;
  }

  if (!intent.gatherRadiusOverride && !intent.previewNeeds) {
    intent.goalId = preview.goalId;
    intent.constraints = preview.constraints;
    intent.previewNeeds = preview.needs;
    lastGoalPreview = preview;
  }
  return intent;
}

async function executeIntentTask(intent, isOwner) {
  const runCtx = {
    id: ++taskSeq,
    intentType: intent.type,
    goalId: intent.goalId || null,
    startedAt: Date.now(),
    currentStepId: null,
    currentStepAction: null,
    lastProgressAt: Date.now(),
    lastProgressMsg: "task started",
    attempt: 0,
    gatherRingIndex: null,
    status: "running",
    cancelled: false,
    preplannedGoal: intent.type === "craftItem" && !intent.gatherRadiusOverride && lastGoalPreview?.ok ? lastGoalPreview : null,
    isCancelled() {
      return this.cancelled;
    }
  };

  if (cfg.structuredAck) {
    const ackStarted = Date.now();
    bot.chat(intentSummary(intent));
    const ackLatencyMs = Date.now() - ackStarted;
    log({ type: "command_ack", taskId: runCtx.id, intent: intent.type, latencyMs: ackLatencyMs });
    if (ackLatencyMs > (cfg.commandAckTimeoutMs || 1000)) {
      log({ type: "command_ack_late", taskId: runCtx.id, intent: intent.type, latencyMs: ackLatencyMs });
    }
  }

  activeTask = runCtx;

  try {
    const taskResult = await planAndRun(bot, intent, () => state, (s) => { state = s; saveState(state); }, log, cfg, runCtx);
    if (taskResult?.status === "fail" && taskResult?.code === "confirm_expand_search" && isOwner) {
      const item = String(taskResult?.meta?.item || intent.item || "resource");
      const fromRadius = Math.max(
        1,
        Number(taskResult?.meta?.fromRadius || (Array.isArray(cfg.gatherRadiusSteps) ? cfg.gatherRadiusSteps[cfg.gatherRadiusSteps.length - 1] : cfg.autoGatherRadius || 48))
      );
      const toRadius = Math.max(fromRadius + 1, Number(taskResult?.meta?.toRadius || cfg.missingResourceExpandedRadius || 120));
      const ttlMs = Math.max(1000, Number(cfg.missingResourceConfirmTimeoutSec || 12) * 1000);
      pendingDecision = {
        kind: "expand_search",
        taskId: runCtx.id,
        goalId: runCtx.goalId || intent.goalId || null,
        item,
        fromRadius,
        toRadius,
        expiresAt: Date.now() + ttlMs,
        resumeIntent: {
          ...intent,
          goalId: null,
          previewNeeds: null,
          gatherRadiusOverride: toRadius
        }
      };
      schedulePendingDecisionTimeout();
      log({
        type: "confirm_expand_search_prompt",
        taskId: runCtx.id,
        goalId: runCtx.goalId || intent.goalId || null,
        item,
        fromRadius,
        toRadius
      });
      bot.chat(`can't find ${item} within ${fromRadius}. expand to ${toRadius} and continue? (yes/no)`);
      return { status: "pending_confirm", taskId: runCtx.id };
    }

    if (taskResult?.status === "fail" || taskResult?.status === "timeout") {
      lastTaskFailure = {
        at: Date.now(),
        taskId: runCtx.id,
        intent: intent.type,
        code: taskResult.code || null,
        reason: taskResult.reason || "failed",
        nextNeed: taskResult.nextNeed || null
      };
    }

    return taskResult || { status: "fail", reason: "unknown task result" };
  } catch (e) {
    lastTaskFailure = {
      at: Date.now(),
      taskId: runCtx.id,
      intent: intent.type,
      code: "exception",
      reason: String(e),
      nextNeed: null
    };
    bot.chat("can't: unsupported request");
    log({ type: "error", where: "planAndRun", e: String(e) });
    return { status: "fail", code: "exception", reason: String(e) };
  } finally {
    if (activeTask && activeTask.id === runCtx.id) {
      activeTask = null;
    }
  }
}

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

  const isOwner = username === cfg.owner;
  const prefix = cfg.commandPrefix || "bot";
  const hasPrefix = hasCommandPrefix(lower, prefix);
  const stripped = stripCommandPrefix(clean, prefix);
  let ownerCommandText = (cfg.commandNoPrefixOwner || hasPrefix) ? stripped : (hasPrefix ? stripped : "");
  let forcedIntent = null;

  if (pendingDecision && Date.now() > pendingDecision.expiresAt) {
    const expired = pendingDecision;
    clearPendingDecision();
    log({
      type: "confirm_expand_search_timeout",
      taskId: expired.taskId,
      goalId: expired.goalId || null,
      item: expired.item,
      fromRadius: expired.fromRadius,
      toRadius: expired.toRadius
    });
    if (isOwner) bot.chat(`can't: search confirmation timed out for ${expired.item}`);
  }

  if (isOwner && pendingDecision?.kind === "expand_search") {
    if (isYesReply(lower)) {
      const pending = pendingDecision;
      forcedIntent = { ...pending.resumeIntent };
      clearPendingDecision();
      log({
        type: "confirm_expand_search_yes",
        taskId: pending.taskId,
        goalId: pending.goalId || null,
        item: pending.item,
        fromRadius: pending.fromRadius,
        toRadius: pending.toRadius
      });
      ownerCommandText = `resume expand search for ${pending.item}`;
    } else if (isNoReply(lower)) {
      const pending = pendingDecision;
      clearPendingDecision();
      log({
        type: "confirm_expand_search_no",
        taskId: pending.taskId,
        goalId: pending.goalId || null,
        item: pending.item,
        fromRadius: pending.fromRadius,
        toRadius: pending.toRadius
      });
      bot.chat(`ok, cancelled expansion for ${pending.item}.`);
      return;
    } else if (looksActionable(ownerCommandText)) {
      clearPendingDecision();
    }
  }

  // HARD kill-switch (owner only)
  if (isOwner && lower.includes("!stopall")) {
    state.stopped = true;
    saveState(state);
    if (activeTask) activeTask.cancelled = true;
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

  // Owner toggle for goal autonomy
  if (isOwner) {
    if (lower.includes("goal off")) { state.goalAutonomy = false; saveState(state); bot.chat("goal off"); return; }
    if (lower.includes("goal on")) { state.goalAutonomy = true; saveState(state); bot.chat("goal on"); return; }
  }

  if (isOwner && lower.includes("!llm test")) {
    const mem = chatMemory.get(username) || [];
    const route = await routePromptWithLLM("say hello", cfg, state, {
      isOwner: true,
      owner: cfg.owner,
      username,
      history: mem
    });
    if (route.kind === "chat" && route.reply) {
      bot.chat(route.reply);
    } else {
      bot.chat("can't: llm route unavailable");
    }
    return;
  }

  if (isOwner && lower === `${prefix} entities`) {
    const list = Object.values(bot.entities)
      .filter((e) => isLivingNonPlayerEntity(e))
      .map((e) => `${getCanonicalEntityName(e) || "unknown"}(${String(e.type || "unknown").toLowerCase()})`)
      .slice(0, 10);
    bot.chat(`living: ${list.length ? list.join(", ") : "none"}`);
    log({ type: "entities_debug", count: Object.keys(bot.entities).length, living: list });
    return;
  }

  if (isOwner && lower === `${prefix} where`) {
    const pos = bot.entity?.position;
    if (pos) bot.chat(`pos: ${pos.x.toFixed(1)} ${pos.y.toFixed(1)} ${pos.z.toFixed(1)}`);
    log({ type: "where", pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : null });
    return;
  }

  if (isOwner && lower === `${prefix} dist`) {
    const owner = bot.players[cfg.owner]?.entity;
    if (owner) {
      const dist = bot.entity.position.distanceTo(owner.position);
      bot.chat(`dist: ${dist.toFixed(1)}`);
      log({ type: "dist", dist });
    }
    return;
  }

  if (isOwner && lower === `${prefix} rawtypes`) {
    const last = recentRawSpawns.slice(-10);
    const line = last
      .map((e) => `${e.rawType}:${e.mapped || "unknown"}@${Math.round(e.x)},${Math.round(e.y)},${Math.round(e.z)}`)
      .join(" | ");
    bot.chat(line || "no rawtypes yet");
    log({ type: "rawtypes", entries: last });
    return;
  }

  if (isOwner && lower === `${prefix} inv`) {
    const items = bot.inventory?.items?.() || [];
    const pretty = items
      .slice()
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .slice(0, 12)
      .map((i) => `${i.name}:${i.count}`)
      .join(", ");
    const tableCount = inventoryCount(bot, "crafting_table");
    const plankCount = inventoryCount(bot, "planks");
    const logCount = inventoryCount(bot, "log");
    const cobbleCount = inventoryCount(bot, "cobblestone");
    bot.chat(`inv table:${tableCount} planks:${plankCount} logs:${logCount} cobble:${cobbleCount}`);
    if (pretty) bot.chat(`inv items: ${pretty}`);
    log({
      type: "inventory_debug",
      tableCount,
      plankCount,
      logCount,
      cobbleCount,
      sample: items.slice(0, 24).map((i) => ({ name: i.name, count: i.count, slot: i.slot }))
    });
    return;
  }

  if (isOwner && lower === `${prefix} needs`) {
    const plan = activeTask?.goalPlan || lastGoalPreview;
    const needs = Array.isArray(plan?.needs) ? plan.needs : [];
    if (!needs.length) {
      bot.chat("needs: none");
      return;
    }
    bot.chat(`needs: ${needs.slice(0, 6).map((n) => n.item ? `${n.item} x${n.count}` : `station:${n.station}`).join(", ")}`);
    return;
  }

  if (isOwner && lower === `${prefix} plan`) {
    const plan = activeTask?.goalPlan || lastGoalPreview;
    const sup = activeTask?.supervisor?.getState?.();
    if (!plan?.steps?.length) {
      bot.chat("plan: none");
      return;
    }
    const activeIndex = sup?.currentStepId
      ? plan.steps.findIndex((s) => s.id === sup.currentStepId)
      : -1;
    const activeSuffix = activeIndex >= 0 ? ` active:${activeIndex + 1}/${plan.steps.length}` : "";
    const summary = plan.steps.slice(0, 8).map((s) => `${s.action}:${s.args?.item || s.args?.station || ""}`).join(" | ");
    bot.chat(`plan(${plan.steps.length}${activeSuffix ? ` ${activeSuffix.trim()}` : ""}): ${summary}`);
    return;
  }

  if (isOwner && lower === `${prefix} status`) {
    const sup = activeTask?.supervisor?.getState?.();
    if (!sup) {
      if (pendingDecision) {
        const left = Math.max(0, Math.ceil((pendingDecision.expiresAt - Date.now()) / 1000));
        bot.chat(`status: pending expand ${pendingDecision.item} ${pendingDecision.fromRadius}->${pendingDecision.toRadius} ttl:${left}s`);
      } else {
        bot.chat("status: idle");
      }
      return;
    }
    const now = Date.now();
    const sinceProgressSec = Math.max(0, Math.floor((now - (sup.lastProgressAt || now)) / 1000));
    const elapsedSec = Math.max(0, Math.floor((sup.elapsedMs || 0) / 1000));
    const pendingSuffix = pendingDecision
      ? ` pending:${pendingDecision.item} ${pendingDecision.fromRadius}->${pendingDecision.toRadius}`
      : "";
    bot.chat(`status: ${sup.status} step:${sup.currentStepAction || "-"} elapsed:${elapsedSec}s last:${sinceProgressSec}s msg:${sup.lastProgressMsg || "-"}${pendingSuffix}`);
    return;
  }

  if (isOwner && lower === `${prefix} lastfail`) {
    if (!lastTaskFailure) {
      bot.chat("lastfail: none");
      return;
    }
    bot.chat(`lastfail: ${lastTaskFailure.code || "task_fail"} ${lastTaskFailure.reason || "failed"}${lastTaskFailure.nextNeed ? ` (next: ${lastTaskFailure.nextNeed})` : ""}`);
    return;
  }

  const commandText = isOwner ? ownerCommandText : clean;
  const history = chatMemory.get(username) || [];

  let intents = [];
  let route = null;
  let compileFailure = null;

  if (forcedIntent) {
    const preparedForced = previewCraftIntent(forcedIntent, username, commandText);
    if (isActionableIntent(preparedForced)) intents.push(preparedForced);
    log({
      type: "intent_decision",
      from: username,
      text: commandText,
      intent: preparedForced,
      threshold: cfg.intentConfidenceThreshold || 0.72,
      resumed: true
    });
  } else if (commandText && ((isOwner && cfg.llmRouteAllOwnerPrompts !== false) || (!isOwner && cfg.llmRouteNonOwnerChat !== false))) {
    log({
      type: "llm_route_start",
      from: username,
      text: commandText,
      owner: isOwner
    });
    route = await routePromptWithLLM(commandText, cfg, state, {
      isOwner,
      owner: cfg.owner,
      username,
      history
    });
    const routeFailure = getLastRouteFailure();
    if (routeFailure?.reason) {
      log({
        type: "llm_route_provider_error",
        from: username,
        provider: routeFailure.provider || cfg.llmProvider,
        reasonCode: routeFailure.reason,
        where: routeFailure.where || "route",
        status: routeFailure.status,
        error: routeFailure.error
      });
      logLlmFailureSignal(routeFailure.provider || cfg.llmProvider, routeFailure, {
        where: routeFailure.where || "route",
        from: username
      });
    }

    log({
      type: "llm_route_result",
      from: username,
      text: commandText,
      kind: route?.kind || "none",
      confidence: route?.confidence || 0,
      reasonCode: route?.reasonCode || null,
      goalCount: Array.isArray(route?.goals) ? route.goals.length : 0,
      goals: Array.isArray(route?.goals) ? route.goals.slice(0, 5).map(summarizeGoal) : [],
      llmReply: typeof route?.reply === "string" ? route.reply : null
    });

    if (route?.kind === "chat" && route.reply) {
      bot.chat(route.reply);
      updateChatMemory(username, "user", clean);
      updateChatMemory(username, "bot", route.reply);
      log({ type: "llm_chat_sent", to: username, reply: route.reply });
      return;
    }

    if (route?.kind === "reject") {
      const reasonCode = route.reasonCode || "unsupported_request";
      log({ type: "llm_route_reject", from: username, reasonCode, confidence: route.confidence || 0 });
      if (isOwner) {
        bot.chat(routeRejectMessage(reasonCode));
      }
      return;
    }

    if (route?.kind === "action") {
      const compiled = compileGoalSpecsToIntents(route.goals || [], bot, cfg, {
        source: "llm",
        confidence: route.confidence || 0.8
      });
      if (!compiled.ok) {
        compileFailure = compiled;
        log({
          type: "llm_goal_compile_fail",
          from: username,
          reasonCode: compiled.reasonCode,
          reason: compiled.reason,
          index: compiled.index
        });
      } else {
        intents = compiled.intents;
        log({
          type: "llm_goal_compile_ok",
          from: username,
          goalCount: (route.goals || []).length,
          intentCount: intents.length,
          intents: intents.map(summarizeIntent)
        });
      }
    }
  }

  if (!intents.length) {
    if (compileFailure && isOwner) {
      bot.chat(routeRejectMessage(compileFailure.reasonCode));
      return;
    }
    if (cfg.chatEnabled && (cfg.chatReplyMode || "short") !== "off") {
      const routeFailure = getLastRouteFailure();
      if (routeFailure?.reason) {
        log({
          type: "chat_no_reply",
          to: username,
          reason: "llm_empty_or_unavailable",
          reasonCode: routeFailure.reason,
          provider: routeFailure.provider || cfg.llmProvider,
          status: routeFailure.status
        });
      }
    }
    return;
  }

  if (!isOwner) {
    log({ type: "intent_reject", from: username, reason: "not_owner", intents });
    return;
  }

  for (const rawIntent of intents) {
    const intent = previewCraftIntent(rawIntent, username, commandText);

    if (activeTask && !isStopIntent(intent)) {
      log({
        type: "command_ignored_busy",
        from: username,
        activeTaskId: activeTask.id,
        activeIntent: activeTask.intentType,
        incomingIntent: summarizeIntent(intent)
      });
      if (isOwner) {
        bot.chat(`busy: ${activeTask.intentType}. send stop to interrupt.`);
      }
      return;
    }

    if (activeTask && isStopIntent(intent)) {
      activeTask.cancelled = true;
      log({ type: "task_cancel", taskId: activeTask.id, reason: "stop_command" });
    }

    if (!isActionableIntent(intent)) {
      if (looksActionable(ownerCommandText) && intent.reason === "ambiguous_target") {
        bot.chat("can't: specify mob target");
        log({ type: "intent_reject", from: username, reason: "ambiguous_target", text: ownerCommandText });
        return;
      }
      if (looksActionable(ownerCommandText) && intent.reason === "unknown_craft_target") {
        bot.chat("can't: unknown craft target");
        log({ type: "intent_reject", from: username, reason: "unknown_craft_target", text: ownerCommandText, requested: intent.requested || null });
        return;
      }
      if (looksActionable(ownerCommandText) && intent.reason === "unsupported_craft_target") {
        bot.chat("can't: unsupported craft target");
        log({
          type: "intent_reject",
          from: username,
          reason: "unsupported_craft_target",
          plannerCode: intent.plannerCode || null,
          text: ownerCommandText,
          requested: intent.requested || null
        });
      }
      return;
    }

    log({
      type: "intent_decision",
      from: username,
      text: ownerCommandText || clean,
      intent,
      threshold: cfg.intentConfidenceThreshold || 0.72,
      llmPrimaryRouting: true,
      llmIntentType: "goal_compiled"
    });

    log({
      type: "llm_to_bot_intent",
      from: username,
      text: ownerCommandText || clean,
      intent: summarizeIntent(intent),
      rawIntent: intent
    });

    const taskResult = await executeIntentTask(intent, isOwner);
    if (!taskResult || taskResult.status !== "success") {
      return;
    }
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
  if (!cfg.logMobSpawns) return;
  if (isLivingNonPlayerEntity(entity)) {
    log({
      type: "entity_spawn",
      name: getCanonicalEntityName(entity) || entity.displayName || entity.name,
      entityType: String(entity.type || "unknown").toLowerCase(),
      kind: entity.kind || null,
      id: entity.id
    });
  }
});

// Low-level packet logging to confirm if entity packets are arriving
bot._client.on("entity_destroy", (packet) => {
  if (!cfg.logEntityPackets) return;
  log({ type: "packet_entity_destroy", ids: packet?.entityIds || [] });
});

bot._client.on("spawn_entity", (packet) => {
  if (!cfg.logEntityPackets) return;
  try {
    const mapped = mapRawEntityType(bot, packet?.type);
    recentRawSpawns.push({
      entityId: packet?.entityId,
      rawType: packet?.type,
      x: packet?.x,
      y: packet?.y,
      z: packet?.z,
      t: Date.now(),
      mapped: mapped?.name || null,
      mappedType: mapped?.type || null,
      mappedCategory: mapped?.category || null
    });
    if (recentRawSpawns.length > 50) recentRawSpawns.shift();
    log({
      event: "packet_spawn_entity",
      entityId: packet?.entityId,
      rawType: packet?.type,
      mappedName: mapped?.name || null,
      mappedType: mapped?.type || null,
      mappedCategory: mapped?.category || null,
      x: packet?.x,
      y: packet?.y,
      z: packet?.z
    });
  } catch (e) {
    log({ event: "packet_spawn_entity", entityId: packet?.entityId, rawType: packet?.type, error: String(e) });
  }
});

bot._client.on("spawn_entity_living", (packet) => {
  if (!cfg.logEntityPackets) return;
  try {
    const mapped = mapRawEntityType(bot, packet?.type);
    log({
      event: "packet_spawn_entity_living",
      entityId: packet?.entityId,
      rawType: packet?.type,
      mappedName: mapped?.name || null,
      mappedType: mapped?.type || null,
      mappedCategory: mapped?.category || null,
      x: packet?.x,
      y: packet?.y,
      z: packet?.z
    });
  } catch (e) {
    log({ event: "packet_spawn_entity_living", entityId: packet?.entityId, rawType: packet?.type, error: String(e) });
  }
});
