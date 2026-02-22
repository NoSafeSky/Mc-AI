const { goals } = require("mineflayer-pathfinder");
const { findRepositionCandidate } = require("./local_reasoner");

function isCancelled(runCtx) {
  return !!runCtx?.isCancelled?.();
}

async function waitTicks(bot, ticks, runCtx) {
  let left = ticks;
  while (left > 0) {
    if (isCancelled(runCtx)) return false;
    const step = Math.min(left, 10);
    await bot.waitForTicks(step);
    left -= step;
  }
  return true;
}

async function moveTo(bot, pos, timeoutMs, runCtx) {
  bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 1));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isCancelled(runCtx)) return false;
    if (bot.entity.position.distanceTo(pos) <= 1.5) return true;
    const ok = await waitTicks(bot, 10, runCtx);
    if (!ok) return false;
  }
  return false;
}

async function reposition(bot, cfg, runCtx, log, stepName) {
  const candidate = findRepositionCandidate(bot, { cfg, log });
  if (!candidate) return false;
  log({
    type: "reasoner_candidate_pick",
    step: stepName,
    x: candidate.standPos.x,
    y: candidate.standPos.y,
    z: candidate.standPos.z,
    score: candidate.score
  });
  const moved = await moveTo(
    bot,
    candidate.standPos,
    cfg.reasoningMoveTimeoutMs || cfg.reasoningStepTimeoutMs || 12000,
    runCtx
  );
  log({
    type: "reasoner_reposition",
    step: stepName,
    moved,
    x: candidate.standPos.x,
    y: candidate.standPos.y,
    z: candidate.standPos.z
  });
  return moved;
}

async function recoverFailure(code, ctx) {
  const bot = ctx.bot;
  const cfg = ctx.cfg || {};
  const runCtx = ctx.runCtx;
  const log = ctx.log || (() => {});
  const stepName = ctx.stepName || "unknown_step";

  if (isCancelled(runCtx)) return false;

  if (code === "station_occupied") {
    const ok = await waitTicks(bot, 20, runCtx);
    if (!ok) return false;
    return reposition(bot, cfg, runCtx, log, stepName);
  }
  if (code === "path_blocked" || code === "target_unreachable" || code === "resource_not_loaded" || code === "standing_in_target_cell") {
    return reposition(bot, cfg, runCtx, log, stepName);
  }
  return false;
}

async function runStepWithCorrection(stepName, fn, ctx = {}, policy = {}) {
  const cfg = ctx.cfg || {};
  const runCtx = ctx.runCtx;
  const log = ctx.log || (() => {});
  const maxCorrections = Number.isFinite(policy.maxCorrections)
    ? policy.maxCorrections
    : (cfg.reasoningMaxCorrectionsPerStep || 6);

  for (let attempt = 0; attempt <= maxCorrections; attempt += 1) {
    if (isCancelled(runCtx)) return { ok: false, status: "cancel", code: "cancelled", reason: "cancelled", recoverable: false };
    log({ type: "reasoner_try", step: stepName, attempt });
    const result = await fn({ attempt });
    if (result?.ok) return result;
    if (result?.status === "cancel") return result;

    const recoverable = !!result?.recoverable;
    if (!recoverable || attempt >= maxCorrections) {
      log({
        type: "reasoner_step_giveup",
        step: stepName,
        attempt,
        recoverable,
        code: result?.code || "unknown",
        reason: result?.reason || "failed"
      });
      return result || { ok: false, recoverable: false, code: "unknown", reason: "failed" };
    }

    const recovered = await recoverFailure(result?.code || "unknown", {
      ...ctx,
      stepName
    });
    if (!recovered) {
      log({
        type: "reasoner_step_giveup",
        step: stepName,
        attempt,
        recoverable: true,
        code: result?.code || "unknown",
        reason: result?.reason || "recover failed"
      });
      return result || { ok: false, recoverable: false, code: "recover_failed", reason: "recover failed" };
    }

    log({
      type: "reasoner_step_recover",
      step: stepName,
      attempt,
      code: result?.code || "unknown",
      reason: result?.reason || "recoverable failure"
    });
  }

  return { ok: false, code: "max_corrections_exceeded", reason: "max correction attempts reached", recoverable: false };
}

async function runGoalWithReplan(options) {
  const {
    initialGoal,
    executeGoal,
    rebuildGoal,
    cfg = {},
    runCtx = null,
    log = () => {}
  } = options || {};

  let goal = initialGoal;
  const maxReplans = Number.isFinite(cfg.maxReplansPerGoal) ? cfg.maxReplansPerGoal : 3;
  const replanEnabled = cfg.replanOnRecoverableFail !== false;

  for (let replan = 0; replan <= maxReplans; replan += 1) {
    if (isCancelled(runCtx)) return { ok: false, status: "cancel", code: "cancelled", reason: "cancelled", recoverable: false };
    const result = await executeGoal(goal, { replan });
    if (result?.ok) return result;
    if (result?.status === "cancel") return result;

    if (!replanEnabled || !result?.recoverable || replan >= maxReplans) {
      if (result?.recoverable && replan >= maxReplans) {
        log({
          type: "goal_replan_exhausted",
          goalId: goal?.goalId || null,
          reason: result?.reason || "recoverable failure",
          code: result?.code || "unknown"
        });
      }
      return result;
    }

    if (typeof rebuildGoal !== "function") return result;
    const rebuilt = await rebuildGoal(goal, { replan: replan + 1 });
    if (!rebuilt?.ok) return rebuilt;
    goal = rebuilt;
    log({
      type: "step_replan",
      goalId: goal?.goalId || null,
      replan: replan + 1
    });
  }

  return { ok: false, code: "replan_exhausted", reason: "replan exhausted", recoverable: false };
}

module.exports = {
  runStepWithCorrection,
  runGoalWithReplan
};
