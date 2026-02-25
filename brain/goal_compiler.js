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

function compileOneGoal(goal, bot, cfg, options = {}) {
  if (!goal || typeof goal !== "object") {
    return fail("invalid_goal_shape", "goal must be an object");
  }

  const source = options.source || "llm";
  const confidence = clamp(goal.confidence ?? options.confidence, 0, 1, 0.8);
  const type = String(goal.type || "").trim();
  const args = goal.args && typeof goal.args === "object" && !Array.isArray(goal.args)
    ? goal.args
    : {};

  if (type === "craftItem") {
    const item = normalizeItemName(args.item || goal.item);
    const count = clamp(args.count ?? goal.count, 1, 64, cfg.craftDefaultCount || 1);
    if (!item) return fail("missing_craft_item", "craftItem requires item");
    if (!knownCraftItem(item, bot?.version || cfg.version || "1.21.1")) {
      return fail("unknown_craft_target", `unknown craft target: ${item}`);
    }
    return { ok: true, intent: { type: "craftItem", item, count, source, confidence } };
  }

  if (type === "attackMob") {
    const rawMob = normalizeEntityName(args.mobType || goal.mobType);
    const mobType = canonicalizeMob(rawMob, bot);
    if (!mobType) return fail("unknown_target", `unknown mob target: ${rawMob || "empty"}`);
    return { ok: true, intent: { type: "attackMob", mobType, source, confidence } };
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
