const fs = require("fs");
const path = require("path");
const mineflayer = require("mineflayer");
const { pathfinder, Movements } = require("mineflayer-pathfinder");
const { plugin: collectBlockPlugin } = require("mineflayer-collectblock");

const { parseNLU } = require("./brain/nlu");
const { planAndRun } = require("./brain/planner");
const { startAutonomy } = require("./brain/autonomy");
const { isLivingNonPlayerEntity, getCanonicalEntityName } = require("./brain/entities");
const { buildGoalPlan } = require("./brain/dependency_planner");
const { buildUnavailableReply } = require("./brain/chat_fallback");
const { isRecipeQuestion, resolveRecipeAnswer } = require("./brain/recipe_qa");
const { buildCapabilitySnapshot } = require("./brain/knowledge");

const cfg = Object.assign(
  {
    commandPrefix: "bot",
    commandNoPrefixOwner: true,
    intentConfidenceThreshold: 0.72,
    structuredAck: true,
    taskTimeoutSec: 60,
    taskNoProgressTimeoutSec: 15,
    taskProgressHeartbeatSec: 3,
    maxTaskDistance: 32,
    noTargetTimeoutSec: 8,
    craftJobTimeoutSec: 90,
    craftGatherRadius: 48,
    craftAutoPlaceTable: true,
    craftDefaultCount: 1,
    cancelOnNewCommand: true,
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
    dependencyMaxNodes: 400,
    dependencyPlanTimeoutMs: 3000,
    supportedStations: ["inventory", "crafting_table", "furnace", "smoker", "blast_furnace", "stonecutter"],
    autoGatherEnabled: true,
    autoGatherRadius: 48,
    gatherRadiusSteps: [24, 48, 72],
    gatherStepTimeoutSec: 12000,
    gatherExpandRetryPerRing: 2,
    autoGatherTimeoutSec: 90,
    replanOnRecoverableFail: true,
    maxReplansPerGoal: 3,
    reasoningStepTimeoutMs: 12000,
    commandAckTimeoutMs: 1000,
    chatReplyMode: "short",
    chatReplyFallbackEnabled: true,
    chatReplyTimeoutMs: 30000,
    recipeQuestionMode: "deterministic",
    recipeQuestionNoAction: true,
    recipeVariantPolicy: "overworld_safe",
    materialFlexPolicy: "inventory_first_any_wood",
    preferBambooForSticks: false,
    strictHarvestToolGate: true,
    autoAcquireRequiredTools: true,
    missingResourcePolicy: "ask_before_move",
    missingResourceConfirmTimeoutSec: 12,
    missingResourceExpandedRadius: 120,
    dynamicMoveTimeoutBaseMs: 12000,
    dynamicMoveTimeoutPerBlockMs: 180,
    ollamaDisableThinking: true,
    ollamaRequestMode: "stable",
    logReasonerCandidateRejects: false,
    logReasonerRejectSummaryEverySec: 5,
    logMobSpawns: false,
    logEntityPackets: false
  },
  JSON.parse(fs.readFileSync("./config.json", "utf8"))
);

const memoryDir = path.join(__dirname, "memory");
if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });

const statePath = path.join(memoryDir, "state.json");
const logPath = path.join(memoryDir, "log.jsonl");

const { llmParseIntent } = require("./brain/llm_nlu");
const { llmChatReply, getLastChatFailure } = require("./brain/llm_chat");
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
function log(evt) {
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
let lastChatAt = 0;
const recentMessages = new Map();
const DUP_WINDOW_MS = 3000;
const pendingSystem = new Map();
let lastReplyAt = 0;
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
    const reply = await llmChatReply("say hello", cfg);
    if (reply) bot.chat(reply);
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

  const recipeQaEnabled = (cfg.recipeQuestionMode || "deterministic").toLowerCase() === "deterministic";
  if (recipeQaEnabled && isRecipeQuestion(clean)) {
    const snapshot = buildCapabilitySnapshot(bot, cfg);
    const answer = resolveRecipeAnswer(clean, bot.version || cfg.version || "1.21.1", cfg, snapshot);
    if (answer.ok) {
      bot.chat(answer.reply);
      log({
        type: "recipe_question_handled",
        from: username,
        text: clean,
        item: answer.item,
        station: answer.station,
        variants: answer.variants
      });
    } else {
      bot.chat("can't: unknown recipe target");
      log({
        type: "recipe_question_unknown",
        from: username,
        text: clean,
        reason: answer.reason,
        rawTarget: answer.rawTarget || null
      });
    }
    if (cfg.recipeQuestionNoAction !== false) {
      return;
    }
  }

  let intent = { type: "none", source: "rules", confidence: 0 };

  if (forcedIntent) {
    intent = forcedIntent;
    log({
      type: "intent_decision",
      from: username,
      text: ownerCommandText,
      intent,
      threshold: cfg.intentConfidenceThreshold || 0.72,
      resumed: true
    });
  } else if (isOwner && ownerCommandText) {
    const confidenceThreshold = cfg.intentConfidenceThreshold || 0.72;
    const ruleIntent = parseNLU(ownerCommandText, cfg, bot);
    intent = ruleIntent;

    const shouldTryLLM = (ruleIntent.type === "none" || (ruleIntent.confidence || 0) < confidenceThreshold) && looksActionable(ownerCommandText);
    if (shouldTryLLM) {
      const llmIntent = await llmParseIntent(ownerCommandText, cfg, state);
      if (llmIntent?.unavailable) {
        log({
          type: "llm_unavailable",
          provider: cfg.llmProvider,
          reason: llmIntent.reason || "unavailable",
          reasonCode: llmIntent.reason || "unavailable",
          status: llmIntent.status,
          error: llmIntent.error
        });
        logLlmFailureSignal(cfg.llmProvider, llmIntent, { where: "intent" });
      }
      if (llmIntent && llmIntent.type !== "none" && (llmIntent.confidence || 0) >= confidenceThreshold) {
        intent = llmIntent;
      }
    }

    if (
      intent.type === "none" &&
      looksActionable(ownerCommandText) &&
      ruleIntent.reason !== "ambiguous_target" &&
      ruleIntent.reason !== "unsupported_craft_item" &&
      ruleIntent.reason !== "unknown_craft_target" &&
      ruleIntent.reason !== "recipe_question"
    ) {
      intent = {
        type: "freeform",
        message: ownerCommandText,
        source: "rules",
        confidence: confidenceThreshold
      };
    }

    log({
      type: "intent_decision",
      from: username,
      text: ownerCommandText,
      intent,
      threshold: confidenceThreshold
    });

  }

  if (
    isOwner &&
    intent.type === "craftItem" &&
    cfg.intelligenceEnabled !== false &&
    cfg.dependencyPlannerEnabled !== false &&
    !intent.gatherRadiusOverride &&
    !intent.previewNeeds
  ) {
    const preview = buildGoalPlan(bot, intent, cfg, null, () => {});
    if (preview?.ok) {
      intent.goalId = preview.goalId;
      intent.constraints = preview.constraints;
      intent.previewNeeds = preview.needs;
      lastGoalPreview = preview;
    }
  }

  if (!isActionableIntent(intent)) {
    if (isOwner && looksActionable(ownerCommandText) && intent.reason === "ambiguous_target") {
      bot.chat("can't: specify mob target");
      log({ type: "intent_reject", from: username, reason: "ambiguous_target", text: ownerCommandText });
      return;
    }
    if (isOwner && looksActionable(ownerCommandText) && intent.reason === "unknown_craft_target") {
      bot.chat("can't: unknown craft target");
      log({ type: "intent_reject", from: username, reason: "unknown_craft_target", text: ownerCommandText, requested: intent.requested || null });
      return;
    }

    if (cfg.chatEnabled) {
      if ((cfg.chatReplyMode || "short") === "off") return;
      const now = Date.now();
      const chatCooldownMs = cfg.chatCooldownMs || 10000;
      const effectiveCooldownMs = isOwner ? 0 : chatCooldownMs;
      const canCallLLM = now - lastChatAt > effectiveCooldownMs && now - lastReplyAt > effectiveCooldownMs;
      if (canCallLLM) {
        const mem = chatMemory.get(username) || [];
        lastChatAt = now;
        mem.push({ role: "user", text: clean });
        const reply = await llmChatReply(message, cfg, mem, {
          timeoutMs: cfg.chatReplyTimeoutMs || cfg.llmTimeoutMs || 3000,
          maxTokens: Math.min(cfg.chatMaxTokens || 80, 48)
        });
        if (reply) {
          bot.chat(reply);
          lastReplyAt = now;
          mem.push({ role: "bot", text: reply });
          while (mem.length > chatMemorySize) mem.shift();
          chatMemory.set(username, mem);
          log({ type: "chat_reply", to: username, reply, source: "llm" });
        } else {
          const failure = getLastChatFailure() || { reason: "llm_empty_or_unavailable", provider: cfg.llmProvider };
          log({
            type: "chat_no_reply",
            to: username,
            reason: "llm_empty_or_unavailable",
            reasonCode: failure.reason || "llm_empty_or_unavailable",
            provider: failure.provider || cfg.llmProvider,
            status: failure.status
          });
          logLlmFailureSignal(failure.provider || cfg.llmProvider, failure, { where: "chat", to: username });
          const fallback = cfg.chatReplyFallbackEnabled === false ? null : buildUnavailableReply(clean);
          if (fallback && (cfg.chatReplyMode || "short") === "short") {
            bot.chat(fallback);
            lastReplyAt = now;
            mem.push({ role: "bot", text: fallback });
            while (mem.length > chatMemorySize) mem.shift();
            chatMemory.set(username, mem);
            log({ type: "chat_reply", to: username, reply: fallback, source: "fallback_unavailable" });
          }
        }
      } else {
        log({ type: "chat_skip_cooldown", to: username, cooldownMs: effectiveCooldownMs });
      }
    }
    return;
  }

  if (!isOwner) {
    log({ type: "intent_reject", from: username, reason: "not_owner", intent });
    return;
  }

  if (cfg.cancelOnNewCommand && activeTask) {
    activeTask.cancelled = true;
    log({ type: "task_cancel", taskId: activeTask.id, reason: "new_command" });
  }

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
      return;
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
  } finally {
    if (activeTask && activeTask.id === runCtx.id) {
      activeTask = null;
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
