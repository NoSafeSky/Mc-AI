const { goals } = require("mineflayer-pathfinder");
const { normalizeItemName } = require("./knowledge");

function isCancelled(runCtx) {
  return !!runCtx?.isCancelled?.();
}

function timeoutsDisabled(cfg = {}) {
  return cfg?.disableTimeouts === true;
}

function parseRings(cfg = {}) {
  const rings = Array.isArray(cfg.missingResourceAutoRings) && cfg.missingResourceAutoRings.length
    ? cfg.missingResourceAutoRings
    : [120, 192, 256];
  const normalized = rings
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  return normalized.length ? normalized : [120, 192, 256];
}

function resourceMatcherFor(itemName) {
  const item = normalizeItemName(itemName);
  if (!item) return () => false;

  if (item === "log" || /(_log|_stem|_hyphae)$/.test(item)) {
    return (b) => !!b && /(_log|_stem|_hyphae)$/.test(String(b.name || ""));
  }
  if (item === "planks") {
    return (b) => !!b && /(_log|_stem|_hyphae)$/.test(String(b.name || ""));
  }
  if (item === "cobblestone" || item === "stone") {
    return (b) => !!b && /(^stone$|cobblestone|deepslate|blackstone)/.test(String(b.name || ""));
  }
  if (item.includes("ore") || item === "raw_iron" || item === "raw_copper" || item === "raw_gold") {
    return (b) => !!b && /ore|deepslate/.test(String(b.name || ""));
  }
  if (item === "sand" || item.includes("sand")) {
    return (b) => !!b && /sand/.test(String(b.name || ""));
  }
  return (b) => !!b && normalizeItemName(b.name) === item;
}

function chooseFallbackOffset(center, ring, seed) {
  const dirs = [
    { x: 1, z: 0 },
    { x: 0, z: 1 },
    { x: -1, z: 0 },
    { x: 0, z: -1 },
    { x: 1, z: 1 },
    { x: -1, z: 1 },
    { x: -1, z: -1 },
    { x: 1, z: -1 }
  ];
  const idx = Math.abs(Number(seed || 0)) % dirs.length;
  const dir = dirs[idx];
  return center.offset(dir.x * ring, 0, dir.z * ring).floored();
}

function chooseRelocationTarget(bot, item, ring, seed) {
  const matcher = resourceMatcherFor(item);
  if (typeof bot.findBlocks === "function") {
    const positions = bot.findBlocks({
      matching: matcher,
      maxDistance: ring,
      count: 48
    }) || [];

    const sorted = positions
      .slice()
      .sort((a, b) => {
        const da = bot.entity.position.distanceTo(a);
        const db = bot.entity.position.distanceTo(b);
        if (da !== db) return da - db;
        if (a.x !== b.x) return a.x - b.x;
        if (a.y !== b.y) return a.y - b.y;
        return a.z - b.z;
      });
    if (sorted.length) return sorted[0];
  }

  return chooseFallbackOffset(bot.entity.position.floored(), ring, seed);
}

async function moveNear(bot, targetPos, timeoutMs, runCtx, cfg = {}) {
  bot.pathfinder.setGoal(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 2));
  const started = Date.now();
  while (timeoutsDisabled(cfg) || (Date.now() - started < timeoutMs)) {
    if (isCancelled(runCtx)) return false;
    if (bot.entity.position.distanceTo(targetPos) <= 3) return true;
    await bot.waitForTicks(10);
  }
  return false;
}

async function autoRelocateForResource(bot, itemName, cfg = {}, runCtx = null, log = () => {}, state = {}) {
  const policy = String(cfg.missingResourcePolicy || "ask_before_move").toLowerCase();
  if (policy !== "auto_relocate") {
    return { ok: false, code: "relocate_disabled", reason: "auto relocate disabled" };
  }

  const maxRelocations = Math.max(0, Number(cfg.missingResourceMaxRelocations || 3));
  const currentCount = Math.max(0, Number(state.relocationCount || 0));
  if (currentCount >= maxRelocations) {
    return {
      ok: false,
      code: "relocate_limit_exhausted",
      reason: `relocation limit reached for ${itemName}`,
      nextNeed: `move to area with ${itemName}`
    };
  }

  const rings = parseRings(cfg);
  const ring = rings[Math.min(currentCount, rings.length - 1)];
  const timeoutMs = Math.max(1000, Number(cfg.missingResourceRelocateTimeoutSec || 45) * 1000);
  const targetPos = chooseRelocationTarget(bot, itemName, ring, (runCtx?.id || 0) + currentCount);

  log({
    type: "relocate_start",
    item: normalizeItemName(itemName),
    ring,
    timeoutMs,
    x: targetPos?.x ?? null,
    y: targetPos?.y ?? null,
    z: targetPos?.z ?? null
  });

  if (!targetPos) {
    log({
      type: "relocate_fail",
      item: normalizeItemName(itemName),
      ring,
      reason: "no_target"
    });
    return {
      ok: false,
      code: "relocate_no_target",
      reason: `no relocation target for ${itemName}`,
      nextNeed: `move to area with ${itemName}`
    };
  }

  const moved = await moveNear(bot, targetPos, timeoutMs, runCtx, cfg);
  if (!moved) {
    log({
      type: "relocate_fail",
      item: normalizeItemName(itemName),
      ring,
      reason: "path_blocked",
      x: targetPos.x,
      y: targetPos.y,
      z: targetPos.z
    });
    return {
      ok: false,
      code: "relocate_failed",
      reason: `failed to relocate for ${itemName}`,
      nextNeed: `move to area with ${itemName}`
    };
  }

  log({
    type: "relocate_ok",
    item: normalizeItemName(itemName),
    ring,
    x: targetPos.x,
    y: targetPos.y,
    z: targetPos.z
  });
  return {
    ok: true,
    ring,
    targetPos
  };
}

module.exports = {
  autoRelocateForResource
};
