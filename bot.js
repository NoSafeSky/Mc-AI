const fs = require("fs");
const path = require("path");
const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { plugin: collectBlockPlugin } = require("mineflayer-collectblock");
let pvpPlugin = null;
let toolPlugin = null;
try {
  pvpPlugin = require("mineflayer-pvp").plugin;
} catch {}
try {
  toolPlugin = require("mineflayer-tool").plugin;
} catch {}

const { planAndRun } = require("./brain/planner");
const { startAutonomy } = require("./brain/autonomy");
const { isLivingNonPlayerEntity, getCanonicalEntityName } = require("./brain/entities");
const { buildGoalPlan } = require("./brain/dependency_planner");
const { routePromptWithLLM, getLastRouteFailure } = require("./brain/llm_router");
const { createCognitiveCore, defaultCognitiveConfig } = require("./brain/cognitive/core");
const { compileGoalSpecsToIntents } = require("./brain/goal_compiler");
const { normalizeCraftItem, resolveDynamicItemName } = require("./brain/crafting_catalog");
const { canonicalizeMob } = require("./brain/nlu");
const {
  ensureMissionState,
  autoStartMatch,
  startMission,
  pauseMission,
  resumeMission,
  abortMission,
  saveCheckpoint,
  getMissionStatus,
  suggestNextTask,
  acceptSuggestion,
  rejectSuggestion,
  missionStatusLine,
  missionPhaseLine,
  missionPlanLine
} = require("./brain/objective_manager");
const { stashStatus, giveItemToOwner, stashNow, dropAllInventory } = require("./brain/team_inventory");
const {
  enqueueCommand,
  dequeueCommand,
  clearQueue,
  queueSummary
} = require("./brain/assistant_queue");

const cfg = Object.assign(
  {
    commandPrefix: "bot",
    commandNoPrefixOwner: true,
    intentConfidenceThreshold: 0.72,
    llmProvider: "groq",
    llmModel: "qwen/qwen3-32b",
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
    disableTimeouts: false,
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
    stationSearchRadius: 32,
    recipeExecutionScope: "craft_smelt_stations",
    craftCoverageMode: "legacy",
    craftRecipeManifestVersion: "1.21.1-overworld-v1",
    stationExecutionEnabled: ["inventory", "crafting_table", "furnace", "smoker", "blast_furnace", "stonecutter", "smithing_table"],
    fuelPolicy: "inventory_first_then_charcoal_then_coal",
    recipePlannerBeamWidth: 24,
    recipeVariantCapPerItem: 32,
    autoGatherEnabled: true,
    autoGatherRadius: 48,
    gatherBlockSampleCount: 128,
    gatherTargetCandidates: 6,
    gatherTargetFailLimit: 2,
    gatherCandidateBanMs: 15000,
    gatherLogCandidateBanMs: 45000,
    gatherLogSameTreeFollowups: 2,
    gatherTreeFailLimit: 2,
    gatherRadiusSteps: [24, 48, 72],
    gatherStepTimeoutSec: 12000,
    gatherExpandRetryPerRing: 2,
    gatherDropRecoveryRetries: 2,
    gatherDropRecoverMoveTimeoutMs: 2500,
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
    assistantModeEnabled: true,
    assistantMissionAdvisory: true,
    assistantAutoExecute: false,
    assistantProposalMode: "single_confirm",
    assistantVerbosePlanning: true,
    assistantQueueEnabled: true,
    assistantQueuePolicy: "fifo",
    assistantQueueMax: 10,
    assistantProposalTimeoutSec: 20,
    assistantRequireOwnerConfirm: true,
    coopObjectiveEnabled: true,
    coopObjectiveType: "dragon_run",
    leaderFollowerMode: true,
    objectiveAssistantMode: true,
    objectiveAutoStartPhrases: [],
    tacticalLlmEnabled: true,
    tacticalLlmProvider: "groq",
    tacticalLlmModel: "qwen/qwen3-32b",
    tacticalLlmTimeoutMs: 1800,
    tacticalLlmMinConfidence: 0.65,
    tacticalLlmMaxCallsPerMin: 12,
    tacticalLlmEventOnly: true,
    movementProfile: "human_cautious",
    movementLookSmoothingDegPerTick: 12,
    movementDisableMicroPause: true,
    movementMicroPauseChance: 0,
    movementMicroPauseMsMin: 90,
    movementMicroPauseMsMax: 260,
    movementStrafeJitterChance: 0.12,
    movementSprintDiscipline: true,
    movementAllowAdvancedParkour: false,
    combatUsePvpPlugin: true,
    combatNoProgressTimeoutMs: 2500,
    combatApproachTimeoutMs: 4000,
    combatPvpBurstTicks: 4,
    combatRetreatHealth: 8,
    combatRetreatFood: 8,
    teamStashEnabled: true,
    teamStashRadius: 12,
    teamStashReservePolicy: "progression_first",
    teamGiveOnDemand: true,
    runCheckpointingEnabled: true,
    runCheckpointIntervalSec: 20,
    ollamaDisableThinking: true,
    ollamaRequestMode: "stable",
    logReasonerCandidateRejects: false,
    logReasonerRejectSummaryEverySec: 5,
    logCompactMode: true,
    logMuteEvents: [],
    logMobSpawns: false,
    logEntityPackets: false,
    smeltTransferRetryLimit: 10,
    smeltInputTransferRetryLimit: 6,
    smeltNoStateChangeMs: 40000,
    goalAutonomy: false,
    cognitiveEnabled: false,
    cognitive: {
      enabled: false,
      ticks: { fastMs: 2000, mediumMs: 10000, slowMs: 60000 },
      initiative: { enabled: true, cooldownMs: 90000, maxCommentsPer10Min: 5 },
      mood: { enabled: true, decayToContentMs: 300000 },
      memory: { episodicMax: 2000, semanticMax: 500, proceduralMax: 200, emotionalMax: 500 },
      llmBudget: { monologueEnabled: false, monologueMaxPer5Min: 3, recallEnabled: false, recallMaxPerMin: 1, timeoutMs: 2000 },
      trust: { enabled: true, start: 0.1, successDelta: 0.02, failDelta: -0.05 },
      autonomyPolicy: { advisoryOnly: true }
    }
  },
  JSON.parse(fs.readFileSync("./config.json", "utf8"))
);

// Backward-compat mapping for one release cycle.
if (!Object.prototype.hasOwnProperty.call(cfg, "assistantAutoExecute")) {
  cfg.assistantAutoExecute = cfg.objectiveAssistantMode === false;
}
if (!Object.prototype.hasOwnProperty.call(cfg, "assistantModeEnabled")) {
  cfg.assistantModeEnabled = cfg.coopObjectiveEnabled !== false;
}
if (!Object.prototype.hasOwnProperty.call(cfg, "assistantMissionAdvisory")) {
  cfg.assistantMissionAdvisory = true;
}
if (!Object.prototype.hasOwnProperty.call(cfg, "assistantQueueEnabled")) {
  cfg.assistantQueueEnabled = true;
}
if (!Object.prototype.hasOwnProperty.call(cfg, "assistantQueuePolicy")) {
  cfg.assistantQueuePolicy = "fifo";
}
if (!Object.prototype.hasOwnProperty.call(cfg, "assistantQueueMax")) {
  cfg.assistantQueueMax = 10;
}
if (!Object.prototype.hasOwnProperty.call(cfg, "assistantProposalMode")) {
  cfg.assistantProposalMode = "single_confirm";
}
if (!Object.prototype.hasOwnProperty.call(cfg, "assistantProposalTimeoutSec")) {
  cfg.assistantProposalTimeoutSec = 20;
}
if (!Object.prototype.hasOwnProperty.call(cfg, "assistantRequireOwnerConfirm")) {
  cfg.assistantRequireOwnerConfirm = true;
}
const cognitiveDefaults = defaultCognitiveConfig(cfg);
if (!Object.prototype.hasOwnProperty.call(cfg, "cognitiveEnabled")) {
  cfg.cognitiveEnabled = cognitiveDefaults.cognitiveEnabled;
}
cfg.cognitive = {
  ...cognitiveDefaults.cognitive,
  ...(cfg.cognitive || {}),
  ticks: {
    ...cognitiveDefaults.cognitive.ticks,
    ...(cfg.cognitive?.ticks || {})
  },
  initiative: {
    ...cognitiveDefaults.cognitive.initiative,
    ...(cfg.cognitive?.initiative || {})
  },
  mood: {
    ...cognitiveDefaults.cognitive.mood,
    ...(cfg.cognitive?.mood || {})
  },
  memory: {
    ...cognitiveDefaults.cognitive.memory,
    ...(cfg.cognitive?.memory || {})
  },
  llmBudget: {
    ...cognitiveDefaults.cognitive.llmBudget,
    ...(cfg.cognitive?.llmBudget || {})
  },
  trust: {
    ...cognitiveDefaults.cognitive.trust,
    ...(cfg.cognitive?.trust || {})
  },
  autonomyPolicy: {
    ...cognitiveDefaults.cognitive.autonomyPolicy,
    ...(cfg.cognitive?.autonomyPolicy || {})
  }
};
if (!Object.prototype.hasOwnProperty.call(cfg.cognitive, "enabled")) {
  cfg.cognitive.enabled = cfg.cognitiveEnabled === true;
}
cfg.cognitiveEnabled = cfg.cognitiveEnabled === true || cfg.cognitive.enabled === true;

const memoryDir = path.join(__dirname, "memory");
if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });

const statePath = path.join(memoryDir, "state.json");
const logPath = path.join(memoryDir, "log.jsonl");

const { inventoryCount } = require("./brain/craft_executor");


function loadState() {
  if (!fs.existsSync(statePath)) {
    const init = {
      creepy: !!cfg.creepy,
      stopped: false,
      base: null,
      doNotTouch: [],
      missionState: null,
      objectiveRun: null
    };
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
ensureMissionState(state, cfg);
saveState(state);
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
let pendingMissionSuggestion = null;
let pendingMissionSuggestionTimer = null;
const assistantQueue = [];
let queueDrainBusy = false;
let idleFollowTimer = null;
let idleFollowEngaged = false;
let idleFollowPausedReason = null;
let cognitive = null;

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

function parseGiveItemPhrase(text, version = "1.21.1", defaultCount = 1) {
  const t = String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const m = /^(?:please\s+)?give\s+me\s+(?:(\d+|a|an)\s+)?(.+)$/.exec(t);
  if (!m) return null;
  const rawItem = String(m[2] || "")
    .replace(/\b(please|now)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!rawItem) {
    return { item: null, count: 1, rawItem: "" };
  }
  let count = Number.parseInt(m[1], 10);
  if (!Number.isFinite(count) || count <= 0) count = (m[1] === "a" || m[1] === "an") ? 1 : (defaultCount || 1);
  count = Math.max(1, Math.min(64, count));
  const item = normalizeCraftItem(rawItem, version) || resolveDynamicItemName(rawItem, version);
  return {
    item: item || null,
    count,
    rawItem
  };
}

const ATTACK_COUNT_WORDS = new Map([
  ["a", 1],
  ["an", 1],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12]
]);

function parseAttackCountToken(raw) {
  const token = String(raw || "").toLowerCase().trim();
  if (!token) return 1;
  const num = Number.parseInt(token, 10);
  if (Number.isFinite(num) && num > 0) return Math.max(1, Math.min(64, num));
  if (ATTACK_COUNT_WORDS.has(token)) return Math.max(1, Math.min(64, ATTACK_COUNT_WORDS.get(token)));
  return 1;
}

function parseAttackCountPhrase(text, bot) {
  const t = String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const m = /\b(kill|attack|hunt|slay)\s+(?:(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+)?(?:the\s+)?([a-z_]+(?:\s+[a-z_]+)?)\b/.exec(t);
  if (!m) return null;
  const mobType = canonicalizeMob(m[3], bot);
  if (!mobType) return null;
  const count = parseAttackCountToken(m[2] || "1");
  return { mobType, count };
}

function looksActionable(text) {
  const t = String(text || "").toLowerCase();
  return /\b(kill|attack|hunt|slay|follow|come|stop|resume|harvest|chop|craft|explore|seek|find|collect|gather|build|mine|bring|run|mission|stash|give|regroup|queue|drop|toss|throw)\b/.test(t);
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
  if (intent.type === "attackMob" && intent.mobType) return `intent: attackMob ${intent.mobType} x${intent.count || 1} (${source})`;
  if (intent.type === "craftItem" && intent.item) {
    const needs = Array.isArray(intent.previewNeeds) && intent.previewNeeds.length
      ? ` | needs: ${intent.previewNeeds.slice(0, 4).map((n) => n.item ? `${n.item} x${n.count}` : `station:${n.station}`).join(", ")}`
      : "";
    return `intent: craftItem ${intent.item} x${intent.count || 1} (${source})${needs}`;
  }
  if (intent.type === "giveItem" && intent.item) return `intent: giveItem ${intent.item} x${intent.count || 1} (${source})`;
  if (intent.type === "dropAllItems") return `intent: dropAllItems (${source})`;
  if (intent.type === "missionStart") return `intent: missionStart (${source})`;
  if (intent.type === "missionStatus" || intent.type === "missionPause" || intent.type === "missionResume" || intent.type === "missionAbort" || intent.type === "missionSuggest" || intent.type === "missionAccept" || intent.type === "missionReject" || intent.type === "queueStatus" || intent.type === "queueClear") {
    return `intent: ${intent.type} (${source})`;
  }
  return `intent: ${intent.type} (${source})`;
}

function summarizeGoal(goal) {
  if (!goal || typeof goal !== "object") return "unknown";
  const type = String(goal.type || "unknown");
  const args = goal.args && typeof goal.args === "object" ? goal.args : {};
  if (type === "craftItem") return `craftItem:${args.item || "?"}x${args.count || 1}`;
  if (type === "attackMob") return `attackMob:${args.mobType || "?"}x${args.count || 1}`;
  if (type === "giveItem") return `giveItem:${args.item || "?"}x${args.count || 1}`;
  if (type === "dropAllItems") return "dropAllItems";
  if (
    type === "missionStart" || type === "missionStatus" || type === "missionSuggest"
    || type === "missionAccept" || type === "missionReject" || type === "missionPause"
    || type === "missionResume" || type === "missionAbort" || type === "queueStatus"
    || type === "queueClear" || type === "stashNow"
    || type === "startObjectiveRun" || type === "runStatus" || type === "runNext"
    || type === "runPause" || type === "runResume" || type === "runAbort"
  ) return type;
  if (type === "explore") return `explore:r${args.radius || "?"}/s${args.seconds || "?"}`;
  if (type === "follow" || type === "come") return `${type}:${args.target || "owner"}`;
  return type;
}

function summarizeIntent(intent) {
  if (!intent || typeof intent !== "object") return "unknown";
  if (intent.type === "craftItem") return `craftItem:${intent.item || "?"}x${intent.count || 1}`;
  if (intent.type === "attackMob") return `attackMob:${intent.mobType || "?"}x${intent.count || 1}`;
  if (intent.type === "giveItem") return `giveItem:${intent.item || "?"}x${intent.count || 1}`;
  if (intent.type === "dropAllItems") return "dropAllItems";
  if (
    intent.type === "missionStart" || intent.type === "missionStatus" || intent.type === "missionSuggest"
    || intent.type === "missionAccept" || intent.type === "missionReject" || intent.type === "missionPause"
    || intent.type === "missionResume" || intent.type === "missionAbort"
    || intent.type === "queueStatus" || intent.type === "queueClear" || intent.type === "stashNow"
    || intent.type === "dropAllItems"
    || intent.type === "startObjectiveRun" || intent.type === "runStatus" || intent.type === "runPause"
    || intent.type === "runResume" || intent.type === "runAbort" || intent.type === "runNext"
  ) return intent.type;
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
  if (cfg.disableTimeouts === true) return;
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

const botOptions = {
  host: cfg.host,
  username: cfg.username,
  version: cfg.version,
  viewDistance: cfg.viewDistance || 10
};
if (Number.isFinite(Number(cfg.port))) {
  botOptions.port = Number(cfg.port);
}

const bot = mineflayer.createBot(botOptions);

function patchDeprecatedPhysicsEventAlias(botRef) {
  const mapEvent = (eventName) => (eventName === "physicTick" ? "physicsTick" : eventName);
  const wrap = (method) => {
    const original = botRef[method];
    if (typeof original !== "function") return;
    botRef[method] = function patchedEventName(eventName, ...args) {
      return original.call(this, mapEvent(eventName), ...args);
    };
  };
  wrap("on");
  wrap("once");
  wrap("addListener");
  wrap("prependListener");
  wrap("removeListener");
  wrap("off");
  wrap("listeners");
  wrap("rawListeners");
  wrap("listenerCount");
}

patchDeprecatedPhysicsEventAlias(bot);


bot.loadPlugin(pathfinder);
bot.loadPlugin(collectBlockPlugin);
if (cfg.combatUsePvpPlugin !== false && typeof pvpPlugin === "function") bot.loadPlugin(pvpPlugin);
if (typeof toolPlugin === "function") bot.loadPlugin(toolPlugin);

// Increase pathfinder stuck timeout to 60s
bot.on("spawn", () => {
  if (bot.pathfinder) {
    bot.pathfinder.stuckTimeout = 60000;
  }
});

bot.once("spawn", () => {
  bot.__runtimeCfg = cfg;
  bot.chat("...");
  log({ type: "spawn" });
  cognitive = createCognitiveCore(bot, cfg, {
    owner: cfg.owner,
    log,
    isBusy: () => !!activeTask || !!pendingDecision || !!pendingMissionSuggestion,
    sendAdvisory: (message, meta = {}) => {
      const text = String(message || "").trim();
      if (!text) return;
      bot.chat(text);
      log({
        type: "cognitive_advisory_chat",
        message: text,
        rule: meta?.rule || null,
        risk: meta?.risk || null
      });
    }
  });
  if (cfg.cognitiveEnabled === true || cfg.cognitive?.enabled === true) {
    cognitive.start();
    log({ type: "cognitive_enabled" });
  } else {
    log({ type: "cognitive_disabled" });
  }
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
  if (cfg.goalAutonomy === true) {
    startAutonomy(bot, () => state, (s) => { state = s; saveState(state); }, log, cfg);
  } else {
    log({ type: "autonomy_disabled" });
  }
  startIdleFollowController();
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
  if (code.includes("missing_item")) return "can't: specify item";
  if (code.includes("too_many_goals")) return "can't: request too broad";
  return "can't: unsupported request";
}

function routeFailureMessage(reasonCode, provider) {
  const code = String(reasonCode || "llm_unavailable").toLowerCase();
  const src = String(provider || cfg.llmProvider || "llm");
  if (code.includes("llm_timeout")) return `can't: ${src} timeout. try again.`;
  if (code.includes("llm_provider_unreachable")) return `can't: ${src} unavailable. check provider.`;
  if (code.includes("llm_thinking_only_response")) return `can't: ${src} returned no final answer.`;
  if (code.includes("llm_empty_response") || code.includes("chat_no_reply")) return `can't: ${src} returned empty response.`;
  return `can't: ${src} unavailable.`;
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

function normalizeMissionControlType(type) {
  const t = String(type || "").toLowerCase();
  if (t === "startobjectiverun") return "missionstart";
  if (t === "runstatus") return "missionstatus";
  if (t === "runnext") return "missionsuggest";
  if (t === "runpause") return "missionpause";
  if (t === "runresume") return "missionresume";
  if (t === "runabort") return "missionabort";
  return t;
}

function isMissionControlIntent(intent) {
  const t = normalizeMissionControlType(intent?.type);
  return t === "missionstart"
    || t === "missionstatus"
    || t === "missionsuggest"
    || t === "missionaccept"
    || t === "missionreject"
    || t === "missionpause"
    || t === "missionresume"
    || t === "missionabort"
    || t === "queuestatus"
    || t === "queueclear";
}

function clearMissionSuggestion() {
  if (pendingMissionSuggestionTimer) {
    clearTimeout(pendingMissionSuggestionTimer);
    pendingMissionSuggestionTimer = null;
  }
  pendingMissionSuggestion = null;
}

function isMissionAcceptReply(text) {
  return /^mission\s+accept$/i.test(String(text || "").trim()) || isYesReply(text);
}

function isMissionRejectReply(text) {
  return /^mission\s+reject$/i.test(String(text || "").trim()) || isNoReply(text);
}

function scheduleMissionSuggestionTimeout() {
  if (cfg.disableTimeouts === true) return;
  if (!pendingMissionSuggestion) return;
  if (pendingMissionSuggestionTimer) clearTimeout(pendingMissionSuggestionTimer);
  const delay = Math.max(1, pendingMissionSuggestion.expiresAt - Date.now());
  pendingMissionSuggestionTimer = setTimeout(() => {
    if (!pendingMissionSuggestion) return;
    if (Date.now() < pendingMissionSuggestion.expiresAt) return;
    const expired = pendingMissionSuggestion;
    clearMissionSuggestion();
    log({
      type: "mission_suggest_timeout",
      suggestionId: expired.id || null,
      phase: expired.phase || null,
      summary: expired.summary || null
    });
    bot.chat("mission: suggestion timed out. ask `what next` for a new recommendation.");
  }, delay);
}

function formatMissionSuggestion(s) {
  if (!s) return "none";
  return `${s.summary} (${s.reason})`;
}

function enqueueIntent(intent, from, rawText) {
  const pushed = enqueueCommand(
    assistantQueue,
    {
      from,
      rawText,
      intent,
      priority: 0
    },
    cfg
  );
  if (!pushed.ok) {
    if (pushed.code === "queue_full") {
      log({
        type: "queue_drop_full",
        from,
        incomingIntent: summarizeIntent(intent),
        max: cfg.assistantQueueMax || 10
      });
      bot.chat(`queue full (${cfg.assistantQueueMax || 10}). clear with \`${cfg.commandPrefix || "bot"} queue clear\`.`);
      return false;
    }
    bot.chat(`can't queue: ${pushed.reason}`);
    return false;
  }
  log({
    type: "queue_push",
    id: pushed.item.id,
    from,
    intent: summarizeIntent(intent),
    size: assistantQueue.length
  });
  bot.chat(`queued: ${summarizeIntent(intent)} (${assistantQueue.length} queued)`);
  return true;
}

function scheduleQueueDrain() {
  if (cfg.assistantQueueEnabled === false) return;
  setTimeout(() => {
    drainAssistantQueue();
  }, 0);
}

async function drainAssistantQueue() {
  if (queueDrainBusy) return;
  if (activeTask) return;
  if (state?.stopped) return;
  if (pendingDecision) return;
  queueDrainBusy = true;
  try {
    while (!state?.stopped && !activeTask && assistantQueue.length) {
      const next = dequeueCommand(assistantQueue);
      if (!next.ok || !next.item?.intent) break;
      log({
        type: "queue_pop",
        id: next.item.id,
        from: next.item.from || null,
        intent: summarizeIntent(next.item.intent),
        remaining: assistantQueue.length
      });
      if (cfg.assistantVerbosePlanning !== false) {
        bot.chat(`queue: executing ${summarizeIntent(next.item.intent)}.`);
      }
      const taskResult = await executeIntentTask(next.item.intent, true);
      if (pendingDecision) break;
    }
  } finally {
    queueDrainBusy = false;
  }
}

function pauseIdleFollow(reason, clearGoal = false) {
  const nextReason = String(reason || "unknown");
  if (idleFollowPausedReason !== nextReason) {
    log({ type: "idle_follow_paused", reason: nextReason });
    idleFollowPausedReason = nextReason;
  }
  if (clearGoal && idleFollowEngaged) {
    try {
      bot.pathfinder.setGoal(null);
    } catch {}
  }
  idleFollowEngaged = false;
}

function idleFollowTick() {
  if (cfg.leaderFollowerMode !== true) {
    pauseIdleFollow("disabled", true);
    return;
  }
  if (!bot?.pathfinder || !bot?.entity?.position) return;
  if (state?.stopped) {
    pauseIdleFollow("stopped", true);
    return;
  }
  if (activeTask) {
    pauseIdleFollow("active_task", false);
    return;
  }

  const owner = bot.players?.[cfg.owner]?.entity;
  if (!owner) {
    pauseIdleFollow("owner_missing", true);
    return;
  }

  if (!idleFollowEngaged) {
    const mcData = require("minecraft-data")(bot.version);
    const movements = new Movements(bot, mcData);
    movements.allow1by1towers = true;
    movements.allowParkour = false;
    movements.canDig = false;
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new goals.GoalFollow(owner, 2), true);
    log({
      type: "idle_follow_engaged",
      owner: cfg.owner,
      distance: Number(bot.entity.position.distanceTo(owner.position).toFixed(2))
    });
    idleFollowEngaged = true;
  }
  idleFollowPausedReason = null;
}

function startIdleFollowController() {
  if (cfg.leaderFollowerMode !== true) return;
  if (idleFollowTimer) clearInterval(idleFollowTimer);
  idleFollowTick();
  idleFollowTimer = setInterval(() => {
    try {
      idleFollowTick();
    } catch (e) {
      log({ type: "idle_follow_error", error: String(e) });
    }
  }, 1500);
}

function buildMissionSuggestMessage(suggested) {
  const phase = suggested.phase;
  const needsText = Array.isArray(suggested.needs) && suggested.needs.length
    ? suggested.needs.slice(0, 5).map((n) => `${n.item} x${n.count}`).join(", ")
    : "none";
  const summary = suggested.suggestion.summary;
  const reason = suggested.suggestion.reason;
  return `mission phase ${phase}. needs: ${needsText}. recommend: ${summary}. reason: ${reason}. reply yes/no.`;
}

function markMissionLastAcceptedTask(taskId) {
  const mission = ensureMissionState(state, cfg);
  if (!mission) return;
  mission.lastAcceptedTaskId = taskId;
  mission.updatedAt = Date.now();
  saveState(state);
}

async function handleMissionControlIntent(intent, username, rawText = "") {
  const type = normalizeMissionControlType(intent?.type);
  ensureMissionState(state, cfg);

  if (type === "missionstart") {
    const started = startMission(state, username || cfg.owner, cfg, log);
    saveState(state);
    if (!started.ok) {
      bot.chat(`mission: ${started.reason}`);
      return true;
    }
    bot.chat("mission: started in assistant mode. I will suggest, you decide.");
    const suggested = suggestNextTask(state, bot, cfg, log);
    if (suggested.ok) {
      pendingMissionSuggestion = {
        id: suggested.suggestion.id,
        taskIntent: suggested.suggestion.intent,
        summary: suggested.suggestion.summary,
        reason: suggested.suggestion.reason,
        source: suggested.suggestion.source || "rules",
        phase: suggested.phase,
        expiresAt: Date.now() + Math.max(1000, Number(cfg.assistantProposalTimeoutSec || 20) * 1000)
      };
      scheduleMissionSuggestionTimeout();
      log({
        type: "mission_suggest",
        missionId: started.mission?.id || null,
        suggestionId: pendingMissionSuggestion.id,
        phase: pendingMissionSuggestion.phase,
        summary: pendingMissionSuggestion.summary,
        reason: pendingMissionSuggestion.reason,
        intentType: pendingMissionSuggestion.taskIntent?.type || null
      });
      bot.chat(buildMissionSuggestMessage(suggested));
    }
    return true;
  }

  if (type === "missionstatus") {
    bot.chat(missionStatusLine(state, bot, cfg, log));
    log({ type: "mission_status" });
    return true;
  }

  if (type === "missionsuggest") {
    let suggested = suggestNextTask(state, bot, cfg, log);
    if (!suggested.ok && suggested.code === "mission_not_active") {
      const started = startMission(state, username || cfg.owner, cfg, log);
      if (started.ok) {
        saveState(state);
        suggested = suggestNextTask(state, bot, cfg, log);
      }
    }
    if (!suggested.ok) {
      log({
        type: "mission_dispatch_blocked",
        reason: suggested.code || "mission_not_ready",
        detail: suggested.reason || null
      });
      bot.chat(`mission: ${suggested.reason}`);
      return true;
    }
    clearMissionSuggestion();
    pendingMissionSuggestion = {
      id: suggested.suggestion.id,
      taskIntent: suggested.suggestion.intent,
      summary: suggested.suggestion.summary,
      reason: suggested.suggestion.reason,
      source: suggested.suggestion.source || "rules",
      phase: suggested.phase,
      expiresAt: Date.now() + Math.max(1000, Number(cfg.assistantProposalTimeoutSec || 20) * 1000)
    };
    scheduleMissionSuggestionTimeout();
    saveState(state);
    bot.chat(buildMissionSuggestMessage(suggested));
    return true;
  }

  if (type === "missionaccept") {
    if (!pendingMissionSuggestion) {
      log({ type: "mission_dispatch_blocked", reason: "no_pending_suggestion" });
      bot.chat("mission: no pending suggestion.");
      return true;
    }
    const suggestion = pendingMissionSuggestion;
    clearMissionSuggestion();
    acceptSuggestion(state, cfg, {
      id: suggestion.id,
      summary: suggestion.summary,
      reason: suggestion.reason,
      intent: suggestion.taskIntent
    }, null, log);
    saveState(state);
    const intentToRun = previewCraftIntent(
      { ...suggestion.taskIntent, source: suggestion.source || "rules", confidence: suggestion.taskIntent?.confidence || 0.9 },
      username,
      rawText || suggestion.summary
    );
    if (cfg.assistantVerbosePlanning !== false) {
      bot.chat(`mission: accepted. executing ${summarizeIntent(intentToRun)} because ${suggestion.reason}.`);
    }
    if (activeTask && !isStopIntent(intentToRun)) {
      enqueueIntent(intentToRun, username, rawText || suggestion.summary);
      return true;
    }
    const taskResult = await executeIntentTask(intentToRun, true);
    if (taskResult?.taskId) markMissionLastAcceptedTask(taskResult.taskId);
    if (!taskResult || taskResult.status !== "success") return true;
    return true;
  }

  if (type === "missionreject") {
    if (!pendingMissionSuggestion) {
      bot.chat("mission: no pending suggestion.");
      return true;
    }
    const suggestion = pendingMissionSuggestion;
    clearMissionSuggestion();
    rejectSuggestion(state, cfg, {
      id: suggestion.id,
      summary: suggestion.summary,
      reason: suggestion.reason,
      intent: suggestion.taskIntent
    }, log);
    saveState(state);
    bot.chat("mission: suggestion rejected. ask `what next` for another option.");
    return true;
  }

  if (type === "missionpause") {
    const paused = pauseMission(state, cfg, log);
    saveState(state);
    bot.chat(paused.ok ? "mission: paused" : `mission: ${paused.reason}`);
    return true;
  }

  if (type === "missionresume") {
    const resumed = resumeMission(state, cfg, log);
    saveState(state);
    bot.chat(resumed.ok ? "mission: resumed" : `mission: ${resumed.reason}`);
    return true;
  }

  if (type === "missionabort") {
    const aborted = abortMission(state, cfg, log);
    saveState(state);
    clearMissionSuggestion();
    bot.chat(aborted.ok ? "mission: aborted" : `mission: ${aborted.reason}`);
    return true;
  }

  if (type === "queuestatus") {
    const summary = queueSummary(assistantQueue);
    if (!summary.size) {
      bot.chat("queue: empty");
      return true;
    }
    const head = summary.first?.intent ? summarizeIntent(summary.first.intent) : "unknown";
    bot.chat(`queue: ${summary.size} pending. next: ${head}`);
    return true;
  }

  if (type === "queueclear") {
    const out = clearQueue(assistantQueue);
    log({ type: "queue_clear", cleared: out.cleared || 0 });
    bot.chat(`queue: cleared ${out.cleared || 0}`);
    return true;
  }

  return false;
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
    const executeFn = () => planAndRun(
      bot,
      intent,
      () => state,
      (s) => { state = s; saveState(state); },
      log,
      cfg,
      runCtx
    );
    const taskResult = cognitive?.wrapExecution
      ? await cognitive.wrapExecution(intent, isOwner, executeFn, { taskId: runCtx.id })
      : await executeFn();
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
      lastTaskFailure = {
        at: Date.now(),
        taskId: runCtx.id,
        intent: intent.type,
        code: taskResult.code || "confirm_expand_search",
        reason: taskResult.reason || `no ${item} nearby`,
        nextNeed: taskResult.nextNeed || `expand search to ${toRadius}`
      };
      bot.chat(`can't find ${item} within ${fromRadius}. expand to ${toRadius} and continue? (yes/no)`);
      return {
        ...taskResult,
        status: "fail",
        taskId: runCtx.id
      };
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

    const out = taskResult || { status: "fail", reason: "unknown task result" };
    if (out.status === "success" && isOwner) {
      bot.chat("Done!");
    }
    if (!Object.prototype.hasOwnProperty.call(out, "taskId")) out.taskId = runCtx.id;
    return out;
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
    return { status: "fail", code: "exception", reason: String(e), taskId: runCtx.id };
  } finally {
    runCtx.cancelled = true;
    if (activeTask && activeTask.id === runCtx.id) {
      activeTask = null;
    }
    scheduleQueueDrain();
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
  try {
    cognitive?.onChat?.(username, clean, isOwner);
  } catch {}
  const prefix = cfg.commandPrefix || "bot";
  const hasPrefix = hasCommandPrefix(lower, prefix);
  const stripped = stripCommandPrefix(clean, prefix);
  let ownerCommandText = (cfg.commandNoPrefixOwner || hasPrefix) ? stripped : (hasPrefix ? stripped : "");
  const ownerLower = String(ownerCommandText || "").toLowerCase().trim();
  let forcedIntent = null;

  if (cfg.disableTimeouts !== true && pendingDecision && Date.now() > pendingDecision.expiresAt) {
    const expired = pendingDecision;
    clearPendingDecision();
    scheduleQueueDrain();
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
      scheduleQueueDrain();
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
      scheduleQueueDrain();
    }
  }

  if (cfg.disableTimeouts !== true && isOwner && pendingMissionSuggestion && Date.now() > pendingMissionSuggestion.expiresAt) {
    const expired = pendingMissionSuggestion;
    clearMissionSuggestion();
    log({
      type: "mission_suggest_timeout",
      suggestionId: expired.id || null,
      phase: expired.phase || null,
      summary: expired.summary || null
    });
    bot.chat("mission: suggestion timed out. ask `what next`.");
  }

  if (isOwner && pendingMissionSuggestion && !pendingDecision) {
    if (isMissionAcceptReply(lower)) {
      forcedIntent = { type: "missionAccept", source: "rules", confidence: 1 };
    } else if (isMissionRejectReply(lower)) {
      forcedIntent = { type: "missionReject", source: "rules", confidence: 1 };
    }
  }

  if (isOwner && !forcedIntent && autoStartMatch(ownerLower || lower, cfg)) {
    forcedIntent = { type: "missionStart", source: "rules", confidence: 1 };
  }
  if (isOwner && !forcedIntent) {
    if (/^mission\s+status$/.test(ownerLower) || /^run\s+status$/.test(ownerLower)) forcedIntent = { type: "missionStatus", source: "rules", confidence: 1 };
    else if (/^mission\s+pause$/.test(ownerLower) || /^run\s+pause$/.test(ownerLower)) forcedIntent = { type: "missionPause", source: "rules", confidence: 1 };
    else if (/^mission\s+resume$/.test(ownerLower) || /^run\s+resume$/.test(ownerLower)) forcedIntent = { type: "missionResume", source: "rules", confidence: 1 };
    else if (/^mission\s+abort$/.test(ownerLower) || /^run\s+abort$/.test(ownerLower)) forcedIntent = { type: "missionAbort", source: "rules", confidence: 1 };
    else if (/^mission\s+(next|suggest)$/.test(ownerLower) || /^run\s+next$/.test(ownerLower) || /^what\s+next$/.test(ownerLower) || /^help\s+me\s+beat\s+minecraft$/.test(ownerLower)) forcedIntent = { type: "missionSuggest", source: "rules", confidence: 1 };
    else if (/^mission\s+accept$/.test(ownerLower)) forcedIntent = { type: "missionAccept", source: "rules", confidence: 1 };
    else if (/^mission\s+reject$/.test(ownerLower)) forcedIntent = { type: "missionReject", source: "rules", confidence: 1 };
    else if (/^mission\s+start$/.test(ownerLower) || /^start\s+run$/.test(ownerLower) || /^run\s+start$/.test(ownerLower)) forcedIntent = { type: "missionStart", source: "rules", confidence: 1 };
    else if (/^queue\s+status$/.test(ownerLower)) forcedIntent = { type: "queueStatus", source: "rules", confidence: 1 };
    else if (/^queue\s+clear$/.test(ownerLower)) forcedIntent = { type: "queueClear", source: "rules", confidence: 1 };
    else if (
      /^dropall$/.test(ownerLower)
      || /^(drop|toss|throw)\s+(?:my\s+|bot'?s\s+|bot\s+|bots\s+)?(?:items?|inventory|inv|stuff|loot)$/.test(ownerLower)
      || /^(drop|toss|throw)\s+all(?:\s+(?:my|bot'?s|bot|bots))?(?:\s+(?:items?|inventory|inv|stuff|loot))?$/.test(ownerLower)
    ) {
      forcedIntent = { type: "dropAllItems", source: "rules", confidence: 1 };
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

  if (isOwner && lower.includes("!llm test")) {
    const mem = chatMemory.get(username) || [];
    const routeCtx = cognitive?.getRouteContext?.() || {};
    const route = await routePromptWithLLM("say hello", cfg, state, {
      isOwner: true,
      owner: cfg.owner,
      username,
      history: mem,
      personalityModifier: routeCtx.personalityModifier || ""
    });
    if (route.kind === "chat" && route.reply) {
      bot.chat(route.reply);
    } else {
      bot.chat("can't: llm route unavailable");
    }
    return;
  }

  if (isOwner && lower === `${prefix} mission status`) {
    bot.chat(missionStatusLine(state, bot, cfg, log));
    return;
  }

  if (isOwner && lower === `${prefix} mission phase`) {
    bot.chat(missionPhaseLine(state, cfg));
    return;
  }
  if (isOwner && lower === `${prefix} run phase`) {
    bot.chat(missionPhaseLine(state, cfg));
    return;
  }

  if (isOwner && lower === `${prefix} mission plan`) {
    bot.chat(missionPlanLine(state, bot, cfg, log));
    return;
  }
  if (isOwner && lower === `${prefix} run plan`) {
    bot.chat(missionPlanLine(state, bot, cfg, log));
    return;
  }

  if (isOwner && lower === `${prefix} mission checkpoint`) {
    const cp = saveCheckpoint(state, bot, cfg, log, "manual");
    saveState(state);
    if (!cp) {
      bot.chat("mission checkpoint: unavailable");
      return;
    }
    bot.chat(`mission checkpoint: ${cp.phase} saved`);
    return;
  }
  if (isOwner && lower === `${prefix} run checkpoint`) {
    const cp = saveCheckpoint(state, bot, cfg, log, "manual");
    saveState(state);
    if (!cp) {
      bot.chat("mission checkpoint: unavailable");
      return;
    }
    bot.chat(`mission checkpoint: ${cp.phase} saved`);
    return;
  }

  if (isOwner && (lower === `${prefix} mission suggest` || lower === `${prefix} mission next` || lower === `${prefix} run next`)) {
    const handled = await handleMissionControlIntent({ type: "missionSuggest", source: "rules", confidence: 1 }, username, clean);
    if (handled) return;
  }

  if (isOwner && lower === `${prefix} queue status`) {
    const handled = await handleMissionControlIntent({ type: "queueStatus", source: "rules", confidence: 1 }, username, clean);
    if (handled) return;
  }

  if (isOwner && lower === `${prefix} queue clear`) {
    const handled = await handleMissionControlIntent({ type: "queueClear", source: "rules", confidence: 1 }, username, clean);
    if (handled) return;
  }

  if (isOwner && lower === `${prefix} run status`) {
    bot.chat(missionStatusLine(state, bot, cfg, log));
    return;
  }

  if (isOwner && lower === `${prefix} stash status`) {
    const s = stashStatus(bot, cfg);
    bot.chat(`stash: ${s.stashFound ? "found" : "none"} critical:${s.criticalCount} noncritical:${s.nonCriticalCount}`);
    return;
  }

  if (isOwner && lower.startsWith(`${prefix} give `)) {
    const raw = lower.slice(`${prefix} give `.length).trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    const item = String(parts[0] || "").trim();
    const count = Math.max(1, Number.parseInt(parts[1] || "1", 10) || 1);
    if (!item) {
      bot.chat("give: specify item");
      return;
    }
    const gave = await giveItemToOwner(bot, cfg.owner, item, count, log);
    if (gave.ok) bot.chat(`gave ${item} x${gave.given}`);
    else bot.chat(`can't give ${item}: ${gave.reason}`);
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
    const mission = ensureMissionState(state, cfg);
    const now = Date.now();
    if (!sup) {
      let status = "idle";
      let msg = "-";
      let pendingSuffix = "";
      if (pendingDecision) {
        const left = Math.max(0, Math.ceil((pendingDecision.expiresAt - now) / 1000));
        status = "pending";
        msg = `expand ${pendingDecision.item} ${pendingDecision.fromRadius}->${pendingDecision.toRadius}`;
        pendingSuffix = ` pending:${pendingDecision.item} ${pendingDecision.fromRadius}->${pendingDecision.toRadius} ttl:${left}s`;
      } else if (pendingMissionSuggestion) {
        const left = Math.max(0, Math.ceil((pendingMissionSuggestion.expiresAt - now) / 1000));
        status = "pending";
        msg = `mission ${pendingMissionSuggestion.summary}`;
        pendingSuffix = ` missionPending:${pendingMissionSuggestion.summary} ttl:${left}s`;
      } else if (mission && mission.status && mission.status !== "idle") {
        status = mission.status;
        msg = `${mission.phase || "mission"} ${mission.lastSuggestionSummary || mission.lastAcceptedSummary || "-"}`.trim();
      }
      bot.chat(`status: ${status} step:- elapsed:0s state:0s heartbeat:0s kind:state msg:${msg}${pendingSuffix}`);
      return;
    }
    const sinceStateSec = Math.max(0, Math.floor((now - (sup.lastStateProgressAt || sup.lastProgressAt || now)) / 1000));
    const sinceHeartbeatSec = Math.max(0, Math.floor((now - (sup.lastHeartbeatAt || sup.lastProgressAt || now)) / 1000));
    const elapsedSec = Math.max(0, Math.floor((sup.elapsedMs || 0) / 1000));
    const pendingSuffix = pendingDecision
      ? ` pending:${pendingDecision.item} ${pendingDecision.fromRadius}->${pendingDecision.toRadius}`
      : (pendingMissionSuggestion ? ` missionPending:${pendingMissionSuggestion.summary}` : "");
    bot.chat(`status: ${sup.status} step:${sup.currentStepAction || "-"} elapsed:${elapsedSec}s state:${sinceStateSec}s heartbeat:${sinceHeartbeatSec}s kind:${sup.lastProgressKind || "state"} msg:${sup.lastProgressMsg || "-"}${pendingSuffix}`);
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
    const routeCtx = cognitive?.getRouteContext?.() || {};
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
      history,
      personalityModifier: routeCtx.personalityModifier || ""
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
        confidence: route.confidence || 0.8,
        commandText
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

  const routeFailure = route ? getLastRouteFailure() : null;

  if (!intents.length) {
    if (compileFailure && isOwner) {
      bot.chat(routeRejectMessage(compileFailure.reasonCode));
      return;
    }
  }

  if (!intents.length) {
    if (cfg.chatEnabled && (cfg.chatReplyMode || "short") !== "off") {
      if (routeFailure?.reason) {
        log({
          type: "chat_no_reply",
          to: username,
          reason: "llm_empty_or_unavailable",
          reasonCode: routeFailure.reason,
          provider: routeFailure.provider || cfg.llmProvider,
          status: routeFailure.status
        });
        if (isOwner) {
          bot.chat(routeFailureMessage(routeFailure.reason, routeFailure.provider));
        }
      }
    }
    return;
  }

  if (!isOwner) {
    log({ type: "intent_reject", from: username, reason: "not_owner", intents });
    return;
  }

  for (const rawIntent of intents) {
    let intent = previewCraftIntent(rawIntent, username, commandText);
    const giveRequest = isOwner
      ? parseGiveItemPhrase(ownerCommandText || clean, bot.version || cfg.version || "1.21.1", cfg.craftDefaultCount || 1)
      : null;
    const attackRequest = isOwner
      ? parseAttackCountPhrase(ownerCommandText || clean, bot)
      : null;

    if (isOwner && giveRequest) {
      if (!giveRequest.item) {
        bot.chat("can't: specify item");
        log({
          type: "intent_reject",
          from: username,
          reason: "missing_item",
          text: ownerCommandText || clean
        });
        return;
      }
      if (intent.type === "craftItem") {
        const before = summarizeIntent(intent);
        intent = {
          type: "giveItem",
          item: giveRequest.item,
          count: giveRequest.count || 1,
          source: intent.source || "rules",
          confidence: intent.confidence || 0.8
        };
        log({
          type: "intent_rewrite",
          from: username,
          reason: "give_phrase_override",
          fromIntent: before,
          toIntent: summarizeIntent(intent)
        });
      } else if (intent.type === "giveItem") {
        intent = {
          ...intent,
          item: giveRequest.item,
          count: giveRequest.count || intent.count || 1
        };
      }
    }

    if (
      isOwner &&
      attackRequest &&
      intent.type === "attackMob" &&
      String(intent.mobType || "") === String(attackRequest.mobType || "")
    ) {
      const nextCount = Math.max(1, Math.min(64, Number(attackRequest.count || 1)));
      if (nextCount !== Number(intent.count || 1)) {
        const before = summarizeIntent(intent);
        intent = {
          ...intent,
          count: nextCount
        };
        log({
          type: "intent_rewrite",
          from: username,
          reason: "attack_count_override",
          fromIntent: before,
          toIntent: summarizeIntent(intent)
        });
      }
    }

    if (isMissionControlIntent(intent)) {
      const handled = await handleMissionControlIntent(intent, username, ownerCommandText || clean);
      if (handled) return;
    }

    if (pendingMissionSuggestion) {
      log({
        type: "mission_reject",
        missionId: ensureMissionState(state, cfg)?.id || null,
        suggestionId: pendingMissionSuggestion.id || null,
        reason: "replaced_by_direct_command"
      });
      clearMissionSuggestion();
    }

    if (intent.type === "stopall") {
      state.stopped = true;
      saveState(state);
      if (activeTask) activeTask.cancelled = true;
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
      const cleared = clearQueue(assistantQueue);
      if (cleared.cleared > 0) {
        log({ type: "queue_clear", cleared: cleared.cleared, reason: "stopall" });
      }
      clearMissionSuggestion();
      clearPendingDecision();
      bot.chat("ok.");
      log({ type: "stopall", by: username });
      return;
    }

    if (intent.type === "stashNow") {
      const stashed = await stashNow(bot, cfg, log);
      if (stashed.ok) bot.chat(`stash: moved ${stashed.moved}`);
      else bot.chat(`stash: ${stashed.reason}`);
      return;
    }

    if (intent.type === "dropAllItems") {
      const dropped = await dropAllInventory(bot, log);
      if (dropped.ok) {
        bot.chat(`dropped all items (${dropped.dropped}).`);
      } else if (dropped.code === "empty_inventory") {
        bot.chat("dropall: inventory empty");
      } else {
        bot.chat(`can't drop all: ${dropped.reason}`);
      }
      return;
    }

    if (intent.type === "giveItem") {
      const gave = await giveItemToOwner(bot, cfg.owner, intent.item, intent.count || 1, log);
      if (gave.ok) bot.chat(`gave ${intent.item} x${gave.given}`);
      else if (gave.code === "item_not_found" || gave.code === "empty_inventory") {
        bot.chat(`can't give ${intent.item}: ${gave.reason}. ask: craft ${intent.item} then give`);
      } else {
        bot.chat(`can't give ${intent.item}: ${gave.reason}`);
      }
      return;
    }

    if (intent.type === "regroup") {
      intent = {
        type: "come",
        target: intent.target || cfg.owner,
        source: intent.source || "rules",
        confidence: intent.confidence || 0.9
      };
    }

    if (activeTask && !isStopIntent(intent)) {
      enqueueIntent(intent, username, ownerCommandText || clean);
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

    if (cfg.assistantVerbosePlanning !== false) {
      const mission = ensureMissionState(state, cfg);
      const missionSuffix = mission && mission.status !== "idle"
        ? ` (mission phase: ${mission.phase})`
        : "";
      bot.chat(`assistant: executing ${summarizeIntent(intent)}${missionSuffix}.`);
    }

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
bot.on("end", () => {
  try {
    cognitive?.stop?.();
  } catch {}
});

bot.on("entitySpawn", (entity) => {
  try {
    cognitive?.onEntityEvent?.("entitySpawn", entity);
  } catch {}
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
  try {
    cognitive?.onEntityEvent?.("packet_entity_destroy", packet);
  } catch {}
  if (!cfg.logEntityPackets) return;
  log({ type: "packet_entity_destroy", ids: packet?.entityIds || [] });
});

bot._client.on("spawn_entity", (packet) => {
  try {
    cognitive?.onEntityEvent?.("packet_spawn_entity", packet);
  } catch {}
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
  try {
    cognitive?.onEntityEvent?.("packet_spawn_entity_living", packet);
  } catch {}
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
