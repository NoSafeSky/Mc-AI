const { normalizeEntityName } = require("./entities");

const ALLOWED_GOAL_TYPES = new Set([
  "craftItem",
  "attackMob",
  "attackHostile",
  "huntFood",
  "follow",
  "come",
  "explore",
  "harvest",
  "stop",
  "stopall",
  "resume",
  "craftBasic",
  "missionStart",
  "missionStatus",
  "missionSuggest",
  "missionAccept",
  "missionReject",
  "missionPause",
  "missionResume",
  "missionAbort",
  "queueStatus",
  "queueClear",
  // deprecated aliases kept for compatibility
  "startObjectiveRun",
  "runNext",
  "runStatus",
  "runPause",
  "runResume",
  "runAbort",
  "giveItem",
  "stashNow",
  "regroup"
]);

const ALLOWED_ROUTE_KINDS = new Set(["action", "chat", "reject", "none"]);

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeItemName(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/^minecraft:/, "")
    .replace(/\s+/g, "_");
}

function knownCraftItem(item, version = "1.21.1") {
  if (!item) return false;
  if (item === "planks") return true;
  try {
    const mcData = require("minecraft-data")(version);
    return !!mcData.itemsByName?.[item];
  } catch {
    return false;
  }
}

function normalizeTarget(target, owner) {
  const t = String(target || "").trim();
  return t || owner || null;
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

function validateGoalSpec(goal, options = {}) {
  if (!goal || typeof goal !== "object" || Array.isArray(goal)) {
    return { ok: false, reasonCode: "invalid_goal_shape", reason: "goal must be an object" };
  }

  const type = normalizeGoalType(goal.type);
  if (!ALLOWED_GOAL_TYPES.has(type)) {
    return { ok: false, reasonCode: "unknown_goal_type", reason: `unknown goal type: ${type || "empty"}` };
  }

  const args = goal.args && typeof goal.args === "object" && !Array.isArray(goal.args)
    ? goal.args
    : {};
  const confidence = clamp(goal.confidence, 0, 1, options.defaultConfidence ?? 0.8);
  const priority = Number.isFinite(goal.priority) ? Math.floor(goal.priority) : undefined;
  const owner = options.owner || null;
  const version = options.version || "1.21.1";

  if (type === "craftItem") {
    const item = normalizeItemName(args.item || goal.item);
    const count = clamp(args.count ?? goal.count, 1, 64, options.defaultCraftCount || 1);
    if (!item) {
      return { ok: false, reasonCode: "missing_craft_item", reason: "craftItem requires args.item" };
    }
    if (!knownCraftItem(item, version)) {
      return { ok: false, reasonCode: "unknown_craft_target", reason: `unknown craft target: ${item}` };
    }
    return {
      ok: true,
      value: {
        type,
        args: { item, count },
        confidence,
        ...(priority !== undefined ? { priority } : {})
      }
    };
  }

  if (type === "attackMob") {
    const mobType = normalizeEntityName(args.mobType || goal.mobType);
    if (!mobType) {
      return { ok: false, reasonCode: "missing_mob", reason: "attackMob requires args.mobType" };
    }
    return {
      ok: true,
      value: {
        type,
        args: { mobType },
        confidence,
        ...(priority !== undefined ? { priority } : {})
      }
    };
  }

  if (type === "explore") {
    const radius = clamp(args.radius ?? goal.radius, 32, options.maxExploreRadius || 500, 200);
    const seconds = clamp(args.seconds ?? goal.seconds, 5, 300, 60);
    return {
      ok: true,
      value: {
        type,
        args: { radius, seconds },
        confidence,
        ...(priority !== undefined ? { priority } : {})
      }
    };
  }

  if (type === "follow" || type === "come") {
    const target = normalizeTarget(args.target || goal.target, owner);
    if (!target) {
      return { ok: false, reasonCode: "missing_target", reason: `${type} requires target` };
    }
    return {
      ok: true,
      value: {
        type,
        args: { target },
        confidence,
        ...(priority !== undefined ? { priority } : {})
      }
    };
  }

  if (type === "regroup") {
    const target = normalizeTarget(args.target || goal.target, owner);
    return {
      ok: true,
      value: {
        type,
        args: { target: target || owner || null },
        confidence,
        ...(priority !== undefined ? { priority } : {})
      }
    };
  }

  if (type === "giveItem") {
    const item = normalizeItemName(args.item || goal.item);
    const count = clamp(args.count ?? goal.count, 1, 64, 1);
    if (!item) {
      return { ok: false, reasonCode: "missing_item", reason: "giveItem requires args.item" };
    }
    return {
      ok: true,
      value: {
        type,
        args: { item, count },
        confidence,
        ...(priority !== undefined ? { priority } : {})
      }
    };
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
    return {
      ok: true,
      value: {
        type,
        args: {},
        confidence,
        ...(priority !== undefined ? { priority } : {})
      }
    };
  }

  return {
    ok: true,
    value: {
      type,
      args: {},
      confidence,
      ...(priority !== undefined ? { priority } : {})
    }
  };
}

function validateGoalList(goals, options = {}) {
  const maxGoals = Math.max(1, Number(options.maxGoals || 5));
  if (!Array.isArray(goals)) {
    return { ok: false, reasonCode: "missing_goals", reason: "goals must be an array" };
  }
  if (goals.length === 0) {
    return { ok: false, reasonCode: "empty_goals", reason: "action route requires at least one goal" };
  }
  if (goals.length > maxGoals) {
    return { ok: false, reasonCode: "too_many_goals", reason: `goals exceed max ${maxGoals}` };
  }

  const out = [];
  for (let i = 0; i < goals.length; i += 1) {
    const validated = validateGoalSpec(goals[i], options);
    if (!validated.ok) {
      return {
        ok: false,
        reasonCode: validated.reasonCode,
        reason: `${validated.reason} at goal index ${i}`,
        index: i
      };
    }
    out.push(validated.value);
  }

  return { ok: true, value: out };
}

function validateRouteObject(route, options = {}) {
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    return { ok: false, reasonCode: "invalid_route_shape", reason: "route must be a JSON object" };
  }

  const kind = String(route.kind || "").trim();
  if (!ALLOWED_ROUTE_KINDS.has(kind)) {
    return { ok: false, reasonCode: "unknown_route_kind", reason: `unknown route kind: ${kind || "empty"}` };
  }

  const confidence = clamp(route.confidence, 0, 1, 0);

  if (kind === "action") {
    const validatedGoals = validateGoalList(route.goals, options);
    if (!validatedGoals.ok) return validatedGoals;
    return {
      ok: true,
      value: {
        kind,
        confidence,
        goals: validatedGoals.value,
        source: "llm",
        notes: typeof route.notes === "string" ? route.notes.trim() : undefined
      }
    };
  }

  if (kind === "chat") {
    const reply = typeof route.reply === "string" ? route.reply.trim() : "";
    if (!reply) {
      return { ok: false, reasonCode: "missing_chat_reply", reason: "chat route requires non-empty reply" };
    }
    return {
      ok: true,
      value: {
        kind,
        confidence,
        reply,
        source: "llm"
      }
    };
  }

  if (kind === "reject") {
    const reasonCode = String(route.reasonCode || "unsupported_request").trim() || "unsupported_request";
    return {
      ok: true,
      value: {
        kind,
        confidence,
        reasonCode,
        source: "llm"
      }
    };
  }

  return {
    ok: true,
    value: {
      kind: "none",
      confidence,
      source: "llm"
    }
  };
}

function parseRouteText(text, options = {}) {
  const raw = String(text || "").trim();
  if (!raw) {
    return { ok: false, reasonCode: "llm_empty_response", reason: "empty response" };
  }

  try {
    const parsed = JSON.parse(raw);
    return validateRouteObject(parsed, options);
  } catch (error) {
    return {
      ok: false,
      reasonCode: "invalid_json",
      reason: String(error)
    };
  }
}

module.exports = {
  ALLOWED_GOAL_TYPES,
  ALLOWED_ROUTE_KINDS,
  validateGoalSpec,
  validateGoalList,
  validateRouteObject,
  parseRouteText,
  normalizeItemName,
  knownCraftItem
};
