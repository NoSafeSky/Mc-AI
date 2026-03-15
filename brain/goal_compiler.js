const { canonicalizeMob } = require("./nlu");
const { normalizeEntityName } = require("./entities");
const { knownCraftItem, normalizeItemName } = require("./llm_goal_schema");

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function fail(reasonCode, reason, index = null) {
  return { ok: false, reasonCode, reason, index };
}

function parseGiveOverride(commandText, version = "1.21.1") {
  const t = String(commandText || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const m = /^(?:please\s+)?give\s+me\s+(?:(\d+|a|an)\s+)?(.+)$/.exec(t);
  if (!m) return null;
  const rawItem = String(m[2] || "")
    .replace(/\b(for me|please|now)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  let count = Number.parseInt(m[1], 10);
  if (!Number.isFinite(count) || count <= 0) count = (m[1] === "a" || m[1] === "an") ? 1 : 1;
  count = Math.max(1, Math.min(64, count));
  if (!rawItem) return { present: true, item: null, count };

  const underscored = rawItem.replace(/\s+/g, "_");
  const singular = underscored.endsWith("s") ? underscored.slice(0, -1) : underscored;
  let resolved = null;
  try {
    const mcData = require("minecraft-data")(version);
    if (mcData?.itemsByName?.[underscored]) resolved = underscored;
    else if (mcData?.itemsByName?.[singular]) resolved = singular;
  } catch {}
  if (!resolved && knownCraftItem(underscored, version)) resolved = underscored;
  if (!resolved && knownCraftItem(singular, version)) resolved = singular;
  return { present: true, item: normalizeItemName(resolved), count };
}

function normalizeGoalType(type) {
  const t = String(type || "").trim();
  if (t === "startObjectiveRun") return "missionStart";
  if (t === "runNext") return "missionSuggest";
  if (t === "runStatus") return "missionStatus";
  if (t === "runPause") return "missionPause";
  if (t === "runResume") return "missionResume";
  if (t === "runAbort") return "missionAbort";
  return t;
}

function compileOneGoal(goal, bot, cfg, options = {}) {
  if (!goal || typeof goal !== "object") {
    return fail("invalid_goal_shape", "goal must be an object");
  }

  const source = options.source || "llm";
  const confidence = clamp(goal.confidence ?? options.confidence, 0, 1, 0.8);
  const type = normalizeGoalType(goal.type);
  const args = goal.args && typeof goal.args === "object" && !Array.isArray(goal.args)
    ? goal.args
    : {};
  const giveOverride = parseGiveOverride(options.commandText, bot?.version || cfg.version || "1.21.1");

  if (type === "craftItem") {
    const item = normalizeItemName(args.item || goal.item);
    const count = clamp(args.count ?? goal.count, 1, 64, cfg.craftDefaultCount || 1);
    if (giveOverride?.present) {
      if (!giveOverride.item) return fail("missing_item", "giveItem requires item");
      return {
        ok: true,
        intent: {
          type: "giveItem",
          item: giveOverride.item,
          count: giveOverride.count || count,
          source,
          confidence
        }
      };
    }
    if (!item) return fail("missing_craft_item", "craftItem requires item");
    if (!knownCraftItem(item, bot?.version || cfg.version || "1.21.1")) {
      return fail("unknown_craft_target", `unknown craft target: ${item}`);
    }
    return { ok: true, intent: { type: "craftItem", item, count, source, confidence } };
  }

  if (type === "attackMob") {
    const rawMob = normalizeEntityName(args.mobType || goal.mobType);
    const count = clamp(args.count ?? goal.count, 1, 64, 1);
    const mobType = canonicalizeMob(rawMob, bot);
    if (!mobType) return fail("unknown_target", `unknown mob target: ${rawMob || "empty"}`);
    return { ok: true, intent: { type: "attackMob", mobType, count, source, confidence } };
  }

  if (type === "explore") {
    const radius = clamp(args.radius ?? goal.radius, 32, cfg.maxExploreRadius || 500, 200);
    const seconds = clamp(args.seconds ?? goal.seconds, 5, 300, 60);
    return { ok: true, intent: { type: "explore", radius, seconds, source, confidence } };
  }

  if (type === "follow" || type === "come") {
    const target = String(args.target || goal.target || cfg.owner || "").trim();
    if (!target) return fail("missing_target", `${type} requires target`);
    return { ok: true, intent: { type, target, source, confidence } };
  }

  if (type === "regroup") {
    const target = String(args.target || goal.target || cfg.owner || "").trim();
    return { ok: true, intent: { type: "regroup", target, source, confidence } };
  }

  if (type === "giveItem") {
    const item = normalizeItemName(args.item || goal.item);
    const count = clamp(args.count ?? goal.count, 1, 64, 1);
    if (!item) return fail("missing_item", "giveItem requires item");
    return { ok: true, intent: { type: "giveItem", item, count, source, confidence } };
  }

  if (
    type === "missionStart"
    || type === "missionStatus"
    || type === "missionSuggest"
    || type === "missionAccept"
    || type === "missionReject"
    || type === "missionPause"
    || type === "missionResume"
    || type === "missionAbort"
    || type === "queueStatus"
    || type === "queueClear"
    || type === "stashNow"
  ) {
    return { ok: true, intent: { type, source, confidence } };
  }

  if (type === "attackHostile" || type === "huntFood" || type === "harvest" || type === "stop" || type === "stopall" || type === "resume" || type === "craftBasic") {
    return { ok: true, intent: { type, source, confidence } };
  }

  return fail("unsupported_goal", `unsupported goal type: ${type || "empty"}`);
}

function compileGoalSpecsToIntents(goals, bot, cfg, options = {}) {
  if (!Array.isArray(goals) || goals.length === 0) {
    return fail("empty_goals", "no goals to compile");
  }

  const intents = [];
  for (let i = 0; i < goals.length; i += 1) {
    const compiled = compileOneGoal(goals[i], bot, cfg, options);
    if (!compiled.ok) {
      return {
        ...compiled,
        index: i
      };
    }
    intents.push(compiled.intent);
  }

  return {
    ok: true,
    intents
  };
}

module.exports = {
  compileGoalSpecsToIntents,
  __test: {
    compileOneGoal
  }
};
