const follow = require("../skills/follow");
const stopall = require("../skills/stopall");
const stalk = require("../skills/stalk");
const harvest = require("../skills/harvest");
const craftBasic = require("../skills/craft_basic");
const { llmPlan, getLastPlanFailure } = require("./llm_plan");
const { buildCraftPlan } = require("./craft_planner");
const { executeCraftPlan, executeGoalPlan } = require("./craft_executor");
const { buildGoalPlan } = require("./dependency_planner");
const { TaskSupervisor } = require("./task_supervisor");
const { goals, Movements } = require("mineflayer-pathfinder");
const { runStepWithCorrection, runGoalWithReplan } = require("./goal_reasoner");
const { moveNearHuman, applyMovementProfile } = require("./motion_controller");
const { executeCombatTurn } = require("./combat_controller");
const {
  isLivingNonPlayerEntity,
  getCanonicalEntityName,
  matchesTargetNameStrict
} = require("./entities");

const TARGET_NAME_ALIASES = new Map([
  ["piggy", "pig"],
  ["piggies", "pig"],
  ["zombi", "zombie"],
  ["zombies", "zombie"],
  ["skeletons", "skeleton"],
  ["creepers", "creeper"],
  ["spiders", "spider"],
  ["cows", "cow"],
  ["sheeps", "sheep"],
  ["chickens", "chicken"],
  ["villagers", "villager"]
]);

function shouldCancel(runCtx) {
  return !!runCtx?.isCancelled?.();
}

function reportProgress(runCtx, message, extra = {}) {
  try {
    if (typeof runCtx?.reportProgress === "function") {
      runCtx.reportProgress(message, extra);
    }
  } catch {}
}

function withIntentOverrides(cfg, intent) {
  if (!intent || !Number.isFinite(Number(intent.gatherRadiusOverride)) || Number(intent.gatherRadiusOverride) <= 0) {
    return cfg;
  }
  const override = Math.floor(Number(intent.gatherRadiusOverride));
  const baseRings = Array.isArray(cfg.gatherRadiusSteps) && cfg.gatherRadiusSteps.length
    ? cfg.gatherRadiusSteps
    : [cfg.autoGatherRadius || cfg.craftGatherRadius || 48];
  const rings = Array.from(new Set([
    ...baseRings.map((n) => Number.parseInt(n, 10)).filter((n) => Number.isFinite(n) && n > 0),
    override
  ])).sort((a, b) => a - b);
  return {
    ...cfg,
    autoGatherRadius: Math.max(Number(cfg.autoGatherRadius || 0), override),
    craftGatherRadius: Math.max(Number(cfg.craftGatherRadius || 0), override),
    gatherRadiusSteps: rings
  };
}

async function waitTicksCancelable(bot, ticks, runCtx) {
  let left = ticks;
  while (left > 0) {
    if (shouldCancel(runCtx)) return false;
    const step = Math.min(left, 10);
    await bot.waitForTicks(step);
    left -= step;
  }
  return true;
}

function chooseNearestLivingEntity(bot, predicate, maxDistance) {
  const entities = Object.values(bot.entities)
    .filter((e) => isLivingNonPlayerEntity(e))
    .map((e) => ({ entity: e, name: getCanonicalEntityName(e) }))
    .filter((row) => !!row.name)
    .filter((row) => predicate(row.name, row.entity))
    .map((row) => row.entity)
    .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
  const nearest = entities[0] || null;
  if (!nearest) return null;
  const dist = bot.entity.position.distanceTo(nearest.position);
  return dist <= maxDistance ? nearest : null;
}

function findNearestTargetByName(bot, targetName, maxDistance, aliases = TARGET_NAME_ALIASES) {
  return chooseNearestLivingEntity(
    bot,
    (entityName) => matchesTargetNameStrict(entityName, targetName, aliases),
    maxDistance
  );
}

function nearbyLivingDiagnostics(bot, maxDistance, limit = 10) {
  return Object.values(bot.entities)
    .filter((e) => isLivingNonPlayerEntity(e))
    .map((e) => ({
      name: getCanonicalEntityName(e),
      type: String(e.type || "unknown").toLowerCase(),
      dist: bot.entity.position.distanceTo(e.position)
    }))
    .filter((e) => !!e.name && e.dist <= maxDistance)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit)
    .map((e) => `${e.name}:${e.type}@${e.dist.toFixed(1)}`);
}

async function moveNear(bot, pos, radius, timeoutMs, runCtx, cfg = {}, log = () => {}) {
  return moveNearHuman(bot, pos, radius, timeoutMs, runCtx, cfg, log, "planner_move");
}

async function executeAttackMob(bot, mobType, cfg, runCtx, log) {
  const maxDistance = cfg.maxTaskDistance || cfg.attackRange || 32;
  const timeoutMs = (cfg.taskTimeoutSec || cfg.attackTimeoutSec || 60) * 1000;
  const noTargetTimeoutMs = Math.min(timeoutMs, (cfg.noTargetTimeoutSec || 8) * 1000);
  const deadline = Date.now() + timeoutMs;
  const noTargetDeadline = Date.now() + noTargetTimeoutMs;
  const mcData = require("minecraft-data")(bot.version);
  const movements = new Movements(bot, mcData);
  movements.allow1by1towers = true;
  movements.allowParkour = false;
  movements.canDig = false;
  bot.pathfinder.setMovements(movements);
  applyMovementProfile(bot, cfg, log);

  let sawAnyTarget = false;
  while (Date.now() < deadline) {
    if (shouldCancel(runCtx)) {
      bot.pathfinder.setGoal(null);
      try { bot.pvp?.stop?.(); } catch {}
      return { status: "cancel" };
    }

    const target = findNearestTargetByName(bot, mobType, maxDistance);

    if (!target) {
      if (Date.now() > noTargetDeadline) {
        const nearby = nearbyLivingDiagnostics(bot, maxDistance);
        log({ type: "target_scan", target: mobType, maxDistance, nearby });
        bot.pathfinder.setGoal(null);
        try { bot.pvp?.stop?.(); } catch {}
        return {
          status: "fail",
          code: "resource_not_loaded",
          reason: `no ${mobType} nearby (within ${maxDistance})`,
          recoverable: true,
          nextNeed: `find ${mobType}`
        };
      }
      const ok = await waitTicksCancelable(bot, 10, runCtx);
      if (!ok) {
        bot.pathfinder.setGoal(null);
        try { bot.pvp?.stop?.(); } catch {}
        return { status: "cancel" };
      }
      continue;
    }

    sawAnyTarget = true;
    const turn = await executeCombatTurn(bot, target, cfg, runCtx, log);
    if (turn?.status === "cancel") {
      bot.pathfinder.setGoal(null);
      try { bot.pvp?.stop?.(); } catch {}
      return { status: "cancel" };
    }
    if (!turn?.ok) {
      if (turn.code === "combat_retreat") {
        bot.pathfinder.setGoal(null);
        try { bot.pvp?.stop?.(); } catch {}
        return {
          status: "fail",
          code: turn.code,
          reason: turn.reason || "retreat required",
          nextNeed: turn.nextNeed || "heal and eat",
          recoverable: false
        };
      }
      const ok = await waitTicksCancelable(bot, 8, runCtx);
      if (!ok) {
        bot.pathfinder.setGoal(null);
        try { bot.pvp?.stop?.(); } catch {}
        return { status: "cancel" };
      }
      continue;
    }
    log({ type: "attack_hit", mobType, target: getCanonicalEntityName(target) || target.displayName || target.name });
    if (!target.isValid) {
      bot.pathfinder.setGoal(null);
      try { bot.pvp?.stop?.(); } catch {}
      return { status: "success" };
    }
  }

  bot.pathfinder.setGoal(null);
  try { bot.pvp?.stop?.(); } catch {}
  if (!sawAnyTarget) {
    const nearby = nearbyLivingDiagnostics(bot, maxDistance);
    log({ type: "target_scan", target: mobType, maxDistance, nearby });
    return { status: "fail", reason: `no ${mobType} nearby (within ${maxDistance})` };
  }
  return { status: "timeout", code: "path_blocked", reason: "path blocked", recoverable: true };
}

function toReasonerResult(result, fallbackCode = "step_failed") {
  if (result?.status === "success") return { ok: true };
  if (result?.status === "cancel") return { ok: false, status: "cancel", code: "cancelled", reason: "cancelled", recoverable: false };
  return {
    ok: false,
    code: result?.code || fallbackCode,
    reason: result?.reason || "failed",
    nextNeed: result?.nextNeed || null,
    recoverable: result?.recoverable !== false
  };
}

async function executeIntent(bot, intent, getState, setState, log, cfg, runCtx, progress = null) {
  if (shouldCancel(runCtx)) return { status: "cancel" };
  if (typeof progress === "function") progress(`intent ${intent.type}`, { stepAction: intent.type });

  if (intent.type === "stalk") {
    if (typeof progress === "function") progress("stalking owner", { stepAction: "stalk" });
    const state = getState();
    state.creepy = true;
    setState(state);
    await stalk(bot, intent.target || cfg.owner, log);
    return { status: "success" };
  }

  if (intent.type === "follow") {
    if (typeof progress === "function") progress("following owner", { stepAction: "follow" });
    applyMovementProfile(bot, cfg, log);
    await follow(bot, intent.target || cfg.owner, log);
    return { status: "success" };
  }

  if (intent.type === "come") {
    if (typeof progress === "function") progress("coming to owner", { stepAction: "come" });
    const owner = bot.players[intent.target || cfg.owner]?.entity;
    if (!owner) return { status: "fail", reason: "path blocked" };
    const mcData = require("minecraft-data")(bot.version);
    const movements = new Movements(bot, mcData);
    movements.allow1by1towers = true;
    movements.allowParkour = false;
    movements.canDig = false;
    bot.pathfinder.setMovements(movements);
    applyMovementProfile(bot, cfg, log);
    const timeoutMs = (cfg.taskTimeoutSec || 60) * 1000;
    const reasoned = await runStepWithCorrection(
      "come",
      async () => toReasonerResult(await moveNear(bot, owner.position.floored(), 1, timeoutMs, runCtx, cfg, log), "path_blocked"),
      { bot, cfg, runCtx, log }
    );
    if (reasoned.ok) {
      bot.chat("ok.");
      log({ type: "come", playerName: intent.target || cfg.owner });
      return { status: "success" };
    }
    if (reasoned.status === "cancel") return { status: "cancel" };
    return { status: "fail", code: reasoned.code, reason: reasoned.reason, recoverable: !!reasoned.recoverable };
  }

  if (intent.type === "stop" || intent.type === "stopall") {
    if (typeof progress === "function") progress("stopping tasks", { stepAction: intent.type });
    if (intent.type === "stopall") {
      const state = getState();
      state.stopped = true;
      setState(state);
    }
    await stopall(bot, log);
    return { status: "success" };
  }

  if (intent.type === "resume") {
    if (typeof progress === "function") progress("resuming", { stepAction: "resume" });
    const state = getState();
    state.stopped = false;
    setState(state);
    bot.chat("resumed.");
    log({ type: "resume" });
    return { status: "success" };
  }

  if (intent.type === "setCreepy") {
    if (typeof progress === "function") progress("updating mode", { stepAction: "setCreepy" });
    const state = getState();
    state.creepy = !!intent.value;
    setState(state);
    bot.chat(state.creepy ? "creepy on." : "creepy off.");
    log({ type: "setCreepy", value: state.creepy });
    return { status: "success" };
  }

  if (intent.type === "harvest") {
    if (typeof progress === "function") progress("harvesting wood", { stepAction: "harvest" });
    const state = getState();
    state.creepy = true;
    setState(state);

    const logBlocks = bot.findBlocks({
      matching: (block) => block && block.name.includes("log"),
      maxDistance: cfg.maxTaskDistance || 64,
      count: 64
    });
    if (!logBlocks || logBlocks.length === 0) {
      return { status: "fail", reason: "no trees nearby" };
    }

    const logTargets = logBlocks.map((pos) => bot.blockAt(pos)).filter(Boolean);
    if (bot.collectBlock && logTargets.length) {
      for (let i = 0; i < 20; i++) {
        if (shouldCancel(runCtx)) return { status: "cancel" };
        const nearbyLogs = bot.findBlocks({
          matching: (block) => block && block.name.includes("log"),
          maxDistance: 6,
          count: 16
        }).map((pos) => bot.blockAt(pos)).filter(Boolean);

        if (!nearbyLogs.length) return { status: "success" };
        try {
          await bot.collectBlock.collect(nearbyLogs[0]);
        } catch (e) {
          log({ type: "harvest_error", error: String(e) });
          return { status: "fail", reason: "path blocked" };
        }
      }
      return { status: "timeout", reason: "path blocked" };
    }

    await harvest(bot, { pos: logBlocks[0] }, log);
    return { status: "success" };
  }

  if (intent.type === "craftItem") {
    const targetItem = intent.item;
    const targetCount = Math.max(1, intent.count || cfg.craftDefaultCount || 1);
    const effectiveCfg = withIntentOverrides(cfg, intent);
    if (typeof progress === "function") progress(`craft ${targetItem} x${targetCount}`, { stepAction: "craftItem" });
    log({ type: "craft_job_start", item: targetItem, count: targetCount });

    if (effectiveCfg.intelligenceEnabled !== false && effectiveCfg.dependencyPlannerEnabled !== false) {
      const initialPlan = runCtx?.preplannedGoal?.ok
        ? runCtx.preplannedGoal
        : buildGoalPlan(bot, intent, effectiveCfg, null, log);
      if (runCtx?.supervisor && initialPlan?.goalId) runCtx.supervisor.setGoalId(initialPlan.goalId);
      if (!initialPlan.ok) {
        log({ type: "craft_job_fail", item: targetItem, count: targetCount, reason: initialPlan.reason, nextNeed: initialPlan.nextNeed || null });
        return {
          status: "fail",
          code: initialPlan.code || "goal_plan_fail",
          reason: `craft ${targetItem}: ${initialPlan.reason}${initialPlan.nextNeed ? ` (next: ${initialPlan.nextNeed})` : ""}`,
          nextNeed: initialPlan.nextNeed || null
        };
      }
      if (runCtx) runCtx.goalPlan = initialPlan;

      const reasoned = await runGoalWithReplan({
        initialGoal: initialPlan,
        executeGoal: async (goal) => {
          if (runCtx) runCtx.goalPlan = goal;
          if (runCtx?.supervisor && goal?.goalId) runCtx.supervisor.setGoalId(goal.goalId);
          const result = await executeGoalPlan(bot, goal, effectiveCfg, runCtx, log, progress);
          if (result.status === "success") return { ok: true };
          if (result.status === "cancel") return { ok: false, status: "cancel", code: "cancelled", reason: "cancelled", recoverable: false };
          return {
            ok: false,
            code: result.code || (result.status === "timeout" ? "path_blocked" : "goal_fail"),
            reason: result.reason || "goal failed",
            nextNeed: result.nextNeed || null,
            recoverable: result.recoverable !== false,
            meta: result.meta || null
          };
        },
        rebuildGoal: async () => buildGoalPlan(bot, intent, effectiveCfg, null, log),
        cfg: effectiveCfg,
        runCtx,
        log
      });

      if (reasoned.ok) {
        log({ type: "craft_job_success", item: targetItem, count: targetCount });
        return { status: "success" };
      }
      if (reasoned.status === "cancel") {
        log({ type: "craft_job_fail", item: targetItem, count: targetCount, reason: "cancelled" });
        return { status: "cancel" };
      }
      if (reasoned.code === "confirm_expand_search") {
        log({
          type: "craft_job_fail",
          item: targetItem,
          count: targetCount,
          reason: reasoned.reason || "confirm search expansion",
          nextNeed: reasoned.nextNeed || null,
          meta: reasoned.meta || null
        });
        return {
          status: "fail",
          code: "confirm_expand_search",
          reason: reasoned.reason || `no ${targetItem} source nearby`,
          nextNeed: reasoned.nextNeed || null,
          meta: reasoned.meta || null,
          recoverable: false
        };
      }
      if (reasoned.code === "path_blocked") {
        log({ type: "craft_job_timeout", item: targetItem, count: targetCount, reason: reasoned.reason });
        return { status: "timeout", code: reasoned.code || "path_blocked", reason: reasoned.reason || "craft job timeout", nextNeed: reasoned.nextNeed || null };
      }
      log({
        type: "craft_job_fail",
        item: targetItem,
        count: targetCount,
        reason: reasoned.reason || "failed",
        nextNeed: reasoned.nextNeed || null,
        code: reasoned.code || "goal_fail"
      });
      return {
        status: "fail",
        code: reasoned.code || "goal_fail",
        reason: `craft ${targetItem}: ${reasoned.reason || "failed"}${reasoned.nextNeed ? ` (next: ${reasoned.nextNeed})` : ""}`,
        nextNeed: reasoned.nextNeed || null,
        meta: reasoned.meta || null
      };
    }

    const legacyPlan = buildCraftPlan(bot, targetItem, targetCount, cfg);
    if (!legacyPlan.ok) {
      log({ type: "craft_job_fail", item: targetItem, count: targetCount, reason: legacyPlan.reason, nextNeed: legacyPlan.nextNeed || null });
      return { status: "fail", reason: `craft ${targetItem}: ${legacyPlan.reason}${legacyPlan.nextNeed ? ` (next: ${legacyPlan.nextNeed})` : ""}` };
    }
    const legacyResult = await executeCraftPlan(bot, legacyPlan, cfg, runCtx, log);
    if (legacyResult.status === "success") return { status: "success" };
    if (legacyResult.status === "cancel") return { status: "cancel" };
    if (legacyResult.status === "timeout") return { status: "timeout", reason: legacyResult.reason || "craft job timeout" };
    return { status: "fail", reason: `craft ${targetItem}: ${legacyResult.reason || "failed"}${legacyResult.nextNeed ? ` (next: ${legacyResult.nextNeed})` : ""}` };
  }

  if (intent.type === "craftBasic") {
    if (typeof progress === "function") progress("craft basic", { stepAction: "craftBasic" });
    await craftBasic(bot, log);
    return { status: "success" };
  }

  if (intent.type === "explore") {
    if (typeof progress === "function") progress("exploring", { stepAction: "explore" });
    const owner = bot.players[cfg.owner]?.entity;
    const center = owner ? owner.position : bot.entity.position;
    const radius = Math.min(cfg.maxExploreRadius || 500, Math.max(32, intent.radius || 128));
    const seconds = Math.max(5, Math.min(300, intent.seconds || cfg.taskTimeoutSec || 60));
    const target = center.offset(
      (Math.random() * radius * 2 - radius) | 0,
      0,
      (Math.random() * radius * 2 - radius) | 0
    ).floored();
    const mcData = require("minecraft-data")(bot.version);
    const movements = new Movements(bot, mcData);
    movements.allow1by1towers = true;
    movements.allowParkour = false;
    movements.canDig = false;
    bot.pathfinder.setMovements(movements);
    applyMovementProfile(bot, cfg, log);

    const reasoned = await runStepWithCorrection(
      "explore",
      async () => toReasonerResult(await moveNear(bot, target, 2, seconds * 1000, runCtx, cfg, log), "path_blocked"),
      { bot, cfg, runCtx, log }
    );
    if (reasoned.ok) return { status: "success" };
    if (reasoned.status === "cancel") return { status: "cancel" };
    return { status: "fail", code: reasoned.code, reason: reasoned.reason, recoverable: !!reasoned.recoverable };
  }

  if (intent.type === "attackMob") {
    if (typeof progress === "function") progress(`attack ${intent.mobType || "mob"}`, { stepAction: "attackMob" });
    const reasoned = await runStepWithCorrection(
      "attackMob",
      async () => toReasonerResult(await executeAttackMob(bot, intent.mobType || "pig", cfg, runCtx, log), "target_unreachable"),
      { bot, cfg, runCtx, log }
    );
    if (reasoned.ok) return { status: "success" };
    if (reasoned.status === "cancel") return { status: "cancel" };
    return { status: "fail", code: reasoned.code, reason: reasoned.reason, nextNeed: reasoned.nextNeed || null, recoverable: !!reasoned.recoverable };
  }

  if (intent.type === "attackHostile") {
    if (typeof progress === "function") progress("attack hostile", { stepAction: "attackHostile" });
    const hostiles = new Set(["zombie", "skeleton", "creeper", "spider", "witch", "enderman"]);
    const target = chooseNearestLivingEntity(bot, (name) => hostiles.has(name), cfg.maxTaskDistance || 32);
    if (!target) return { status: "fail", reason: "no hostile nearby" };
    return executeIntent(
      bot,
      { type: "attackMob", mobType: getCanonicalEntityName(target) || "zombie" },
      getState,
      setState,
      log,
      cfg,
      runCtx,
      progress
    );
  }

  if (intent.type === "huntFood") {
    if (typeof progress === "function") progress("hunt food", { stepAction: "huntFood" });
    const passive = new Set(["pig", "cow", "sheep", "chicken"]);
    const target = chooseNearestLivingEntity(bot, (name) => passive.has(name), cfg.maxTaskDistance || 32);
    if (!target) return { status: "fail", reason: "no food mobs nearby" };
    return executeIntent(
      bot,
      { type: "attackMob", mobType: getCanonicalEntityName(target) || "pig" },
      getState,
      setState,
      log,
      cfg,
      runCtx,
      progress
    );
  }

  if (intent.type === "freeform" && intent.message) {
    if (typeof progress === "function") progress("planning freeform request", { stepAction: "freeform" });
    const plan = await llmPlan(intent.message, cfg, getState());
    log({ type: "plan", message: intent.message, plan });
    if (!plan) {
      const failure = getLastPlanFailure();
      if (failure?.reason && String(failure.reason).startsWith("llm_")) {
        const base = {
          provider: failure.provider || cfg.llmProvider || "unknown",
          reasonCode: failure.reason,
          status: failure.status,
          error: failure.error
        };
        log({
          type: "llm_unavailable",
          provider: base.provider,
          reason: failure.reason,
          reasonCode: base.reasonCode,
          status: base.status,
          error: base.error
        });
        if (failure.reason === "llm_empty_response") {
          log({ type: "llm_empty_response", ...base, where: "plan" });
        } else if (failure.reason === "llm_thinking_only_response") {
          log({ type: "llm_thinking_only_response", ...base, where: "plan", hasThinking: !!failure.hasThinking });
        } else if (failure.reason === "llm_provider_unreachable") {
          log({ type: "llm_provider_unreachable", ...base, where: "plan" });
        }
      }
      return { status: "fail", reason: "unsupported request" };
    }

    for (const step of plan.steps) {
      if (shouldCancel(runCtx)) return { status: "cancel" };
      let mappedIntent = null;
      if (step.action === "followOwner") mappedIntent = { type: "follow", target: cfg.owner };
      else if (step.action === "comeOwner") mappedIntent = { type: "come", target: cfg.owner };
      else if (step.action === "harvestWood") mappedIntent = { type: "harvest" };
      else if (step.action === "craftBasic") mappedIntent = { type: "craftBasic" };
      else if (step.action === "explore" || step.action === "seekVillage") {
        mappedIntent = { type: "explore", radius: step.radius, seconds: step.seconds };
      } else if (step.action === "attackMob") mappedIntent = { type: "attackMob", mobType: step.mobType || "pig" };
      else if (step.action === "attackHostile") mappedIntent = { type: "attackHostile" };
      else if (step.action === "huntFood") mappedIntent = { type: "huntFood" };
      else if (step.action === "wait") {
        const ok = await waitTicksCancelable(bot, (step.seconds || 15) * 20, runCtx);
        if (!ok) return { status: "cancel" };
        continue;
      }
      if (!mappedIntent) continue;
      const stepResult = await executeIntent(bot, mappedIntent, getState, setState, log, cfg, runCtx, progress);
      if (typeof progress === "function") progress(`freeform step ${step.action}`, { stepAction: step.action });
      if (stepResult.status !== "success") return stepResult;
    }
    return { status: "success" };
  }

  return { status: "fail", reason: "unsupported request" };
}

async function planAndRun(bot, intent, getState, setState, log, cfg, runCtx = null) {
  const supervisor = new TaskSupervisor({
    bot,
    runCtx,
    cfg,
    log,
    intentType: intent?.type || "unknown",
    goalId: intent?.goalId || null
  });

  if (runCtx) {
    runCtx.supervisor = supervisor;
    runCtx.status = "running";
    runCtx.reportProgress = (message, extra = {}) => supervisor.reportProgress(message, extra);
    runCtx.setStep = (stepId, stepAction, extra = {}) => supervisor.setStep(stepId, stepAction, extra);
    runCtx.getTaskState = () => supervisor.getState();
  }

  log({
    type: "task_start",
    taskId: runCtx?.id || null,
    intent
  });
  supervisor.reportProgress("task started", { stepAction: intent.type });

  try {
    const result = await executeIntent(
      bot,
      intent,
      getState,
      setState,
      log,
      cfg,
      runCtx,
      (message, extra = {}) => supervisor.reportProgress(message, extra)
    );

    if (runCtx?.stallResult) {
      const stalled = runCtx.stallResult;
      const reason = stalled.reason || "stalled";
      log({
        type: "task_fail",
        taskId: runCtx?.id || null,
        intent: intent.type,
        reason,
        code: stalled.code || "task_stalled",
        nextNeed: stalled.nextNeed || null
      });
      log({
        type: "task_fail_detail",
        taskId: runCtx?.id || null,
        intent: intent.type,
        status: "fail",
        reason,
        code: stalled.code || "task_stalled",
        nextNeed: stalled.nextNeed || null
      });
      bot.chat(`can't: ${reason}${stalled.nextNeed ? ` (next: ${stalled.nextNeed})` : ""}`);
      supervisor.finish("fail", {
        code: stalled.code || "task_stalled",
        reason,
        nextNeed: stalled.nextNeed || null
      });
      if (runCtx) runCtx.status = "fail";
      return {
        status: "fail",
        code: stalled.code || "task_stalled",
        reason,
        nextNeed: stalled.nextNeed || null
      };
    }

    if (result.status === "success") {
      log({ type: "task_success", taskId: runCtx?.id || null, intent: intent.type });
      supervisor.finish("success");
      if (runCtx) runCtx.status = "success";
      return { status: "success" };
    }

    if (result.status === "cancel") {
      log({ type: "task_cancel", taskId: runCtx?.id || null, intent: intent.type });
      supervisor.finish("cancel");
      if (runCtx) runCtx.status = "cancel";
      return { status: "cancel" };
    }

    if (result.status === "timeout") {
      log({
        type: "task_timeout",
        taskId: runCtx?.id || null,
        intent: intent.type,
        reason: result.reason || "timeout",
        code: result.code || "timeout",
        nextNeed: result.nextNeed || null
      });
      log({
        type: "task_fail_detail",
        taskId: runCtx?.id || null,
        intent: intent.type,
        status: "timeout",
        reason: result.reason || "timeout",
        code: result.code || "timeout",
        nextNeed: result.nextNeed || null
      });
      bot.chat(`can't: ${result.reason || "timeout"}`);
      supervisor.finish("timeout", {
        code: result.code || "timeout",
        reason: result.reason || "timeout",
        nextNeed: result.nextNeed || null
      });
      if (runCtx) runCtx.status = "timeout";
      return {
        status: "timeout",
        code: result.code || "timeout",
        reason: result.reason || "timeout",
        nextNeed: result.nextNeed || null
      };
    }

    log({
      type: "task_fail",
      taskId: runCtx?.id || null,
      intent: intent.type,
      reason: result.reason || "failed",
      code: result.code || "task_fail",
      nextNeed: result.nextNeed || null
    });
    log({
      type: "task_fail_detail",
      taskId: runCtx?.id || null,
      intent: intent.type,
      status: "fail",
      reason: result.reason || "failed",
      code: result.code || "task_fail",
      nextNeed: result.nextNeed || null
    });
    if (result.code !== "confirm_expand_search") {
      bot.chat(`can't: ${result.reason || "unsupported request"}`);
    }
    supervisor.finish("fail", {
      code: result.code || "task_fail",
      reason: result.reason || "failed",
      nextNeed: result.nextNeed || null
    });
    if (runCtx) runCtx.status = "fail";
    return {
      status: "fail",
      code: result.code || "task_fail",
      reason: result.reason || "failed",
      nextNeed: result.nextNeed || null,
      meta: result.meta || null
    };
  } catch (e) {
    const reason = String(e);
    log({ type: "task_fail", taskId: runCtx?.id || null, intent: intent.type, reason, code: "exception" });
    log({
      type: "task_fail_detail",
      taskId: runCtx?.id || null,
      intent: intent.type,
      status: "fail",
      reason,
      code: "exception",
      nextNeed: null
    });
    bot.chat("can't: unsupported request");
    supervisor.finish("fail", { code: "exception", reason, nextNeed: null });
    if (runCtx) runCtx.status = "fail";
    return { status: "fail", code: "exception", reason, nextNeed: null };
  } finally {
    supervisor.finish(runCtx?.status || "running");
  }
}

module.exports = {
  planAndRun,
  __test: {
    chooseNearestLivingEntity,
    findNearestTargetByName,
    nearbyLivingDiagnostics,
    TARGET_NAME_ALIASES
  }
};
