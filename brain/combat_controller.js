const { moveNearHuman, maybeStrafeJitter } = require("./motion_controller");

function isCancelled(runCtx) {
  return !!runCtx?.isCancelled?.();
}

function normalizeItemName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/^minecraft:/, "")
    .trim();
}

function inventoryRows(bot) {
  if (!bot?.inventory) return [];
  if (typeof bot.inventory.items === "function") {
    const listed = bot.inventory.items();
    if (Array.isArray(listed)) return listed;
  }
  const slots = Array.isArray(bot.inventory.slots) ? bot.inventory.slots.filter(Boolean) : [];
  return slots;
}

const MELEE_WEAPON_SCORES = {
  wooden_sword: 40,
  golden_sword: 40,
  stone_sword: 50,
  iron_sword: 60,
  diamond_sword: 70,
  netherite_sword: 80,
  wooden_axe: 70,
  golden_axe: 70,
  stone_axe: 90,
  iron_axe: 90,
  diamond_axe: 90,
  netherite_axe: 100,
  trident: 80,
  mace: 95
};

function meleeWeaponScore(itemName) {
  const name = normalizeItemName(itemName);
  if (!name) return -1;
  if (Object.prototype.hasOwnProperty.call(MELEE_WEAPON_SCORES, name)) {
    return Number(MELEE_WEAPON_SCORES[name]);
  }
  return -1;
}

function pickBestCombatWeapon(bot) {
  const rows = inventoryRows(bot);
  let best = null;
  for (const row of rows) {
    const score = meleeWeaponScore(row?.name);
    if (score < 0) continue;
    if (!best || score > best.score) {
      best = { item: row, score };
    }
  }
  return best ? best.item : null;
}

async function equipBestCombatWeapon(bot, log = () => {}) {
  if (typeof bot?.equip !== "function") return null;
  const best = pickBestCombatWeapon(bot);
  if (!best) return null;
  const held = normalizeItemName(bot?.heldItem?.name || "");
  const desired = normalizeItemName(best.name);
  if (held && held === desired) return desired;
  try {
    await bot.equip(best, "hand");
    log({
      type: "combat_weapon_equip",
      equipped: desired
    });
    return desired;
  } catch (e) {
    log({
      type: "combat_weapon_equip_fail",
      weapon: desired,
      reason: String(e?.message || e || "equip failed")
    });
    return null;
  }
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
    const approachCfg = {
      ...cfg,
      movementNoProgressTimeoutMs: Number(cfg.combatNoProgressTimeoutMs || 2500)
    };
    const move = await moveNearHuman(
      bot,
      target.position,
      2,
      Math.max(1500, Number(cfg.combatApproachTimeoutMs || 4000)),
      runCtx,
      approachCfg,
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
  await equipBestCombatWeapon(bot, log);

  try {
    let usedPvp = false;
    if (cfg.combatUsePvpPlugin !== false && bot.pvp && typeof bot.pvp.attack === "function") {
      usedPvp = true;
      bot.pvp.attack(target);
    } else {
      bot.attack(target);
    }
    if (usedPvp) {
      const pvpTicks = Math.max(1, Number(cfg.combatPvpBurstTicks || 4));
      const pvpOk = await waitTicksCancelable(bot, pvpTicks, runCtx);
      if (!pvpOk) return { ok: false, status: "cancel", code: "cancelled", reason: "cancelled", recoverable: false };
      try { bot.pvp?.stop?.(); } catch {}
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
  executeCombatTurn,
  __test: {
    meleeWeaponScore,
    pickBestCombatWeapon
  }
};
