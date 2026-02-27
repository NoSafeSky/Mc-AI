const { moveNearHuman, maybeStrafeJitter } = require("./motion_controller");

function isCancelled(runCtx) {
  return !!runCtx?.isCancelled?.();
}

async function waitTicksCancelable(bot, ticks, runCtx) {
  let left = Math.max(0, Number(ticks || 0));
  while (left > 0) {
    if (isCancelled(runCtx)) return false;
    const step = Math.min(left, 10);
    await bot.waitForTicks(step);
    left -= step;
  }
  return true;
}

function shouldRetreat(bot, cfg = {}) {
  const hp = Number(bot?.health ?? 20);
  const food = Number(bot?.food ?? 20);
  const hpGate = Number(cfg.combatRetreatHealth ?? 8);
  const foodGate = Number(cfg.combatRetreatFood ?? 8);
  if (hp <= hpGate) return { retreat: true, reason: `low health (${hp})` };
  if (food <= foodGate) return { retreat: true, reason: `low food (${food})` };
  return { retreat: false, reason: null };
}

async function executeCombatTurn(bot, target, cfg = {}, runCtx = null, log = () => {}) {
  if (!target?.position) {
    return { ok: false, code: "target_unreachable", reason: "target missing", recoverable: true };
  }
  if (isCancelled(runCtx)) return { ok: false, status: "cancel", code: "cancelled", reason: "cancelled", recoverable: false };

  const retreat = shouldRetreat(bot, cfg);
  if (retreat.retreat) {
    log({
      type: "combat_retreat",
      reason: retreat.reason,
      health: Number(bot?.health ?? 20),
      food: Number(bot?.food ?? 20)
    });
    return {
      ok: false,
      code: "combat_retreat",
      reason: retreat.reason,
      nextNeed: "heal and eat",
      recoverable: false
    };
  }

  const dist = bot.entity.position.distanceTo(target.position);
  if (dist > 3.2) {
    const move = await moveNearHuman(
      bot,
      target.position,
      2,
      Math.max(2000, Number(cfg.reasoningStepTimeoutMs || 12000)),
      runCtx,
      cfg,
      log,
      "combat_approach"
    );
    if (move.status === "cancel") return { ok: false, status: "cancel", code: "cancelled", reason: "cancelled", recoverable: false };
    if (move.status !== "success") {
      return {
        ok: false,
        code: move.code || "path_blocked",
        reason: move.reason || "path blocked",
        nextNeed: "move to open area",
        recoverable: true
      };
    }
  }

  await maybeStrafeJitter(bot, cfg, runCtx, log);
  if (isCancelled(runCtx)) return { ok: false, status: "cancel", code: "cancelled", reason: "cancelled", recoverable: false };

  try {
    if (cfg.combatUsePvpPlugin !== false && bot.pvp && typeof bot.pvp.attack === "function") {
      bot.pvp.attack(target);
    } else {
      bot.attack(target);
    }
  } catch (e) {
    return {
      ok: false,
      code: "target_unreachable",
      reason: `attack failed: ${String(e)}`,
      nextNeed: "move closer",
      recoverable: true
    };
  }

  const waited = await waitTicksCancelable(bot, 8, runCtx);
  if (!waited) return { ok: false, status: "cancel", code: "cancelled", reason: "cancelled", recoverable: false };
  return { ok: true };
}

module.exports = {
  shouldRetreat,
  executeCombatTurn
};
