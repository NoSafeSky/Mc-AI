const { normalizeItemName } = require("./knowledge");

const PROGRESSION_CRITICAL = new Set([
  "wooden_pickaxe",
  "stone_pickaxe",
  "iron_pickaxe",
  "diamond_pickaxe",
  "bucket",
  "shield",
  "flint_and_steel",
  "blaze_rod",
  "ender_pearl",
  "eye_of_ender",
  "obsidian",
  "iron_ingot",
  "diamond",
  "food",
  "arrow",
  "bow"
]);

function inventoryRows(bot) {
  if (!bot?.inventory) return [];
  if (typeof bot.inventory.items === "function") return bot.inventory.items();
  return [];
}

function inventoryCountByName(bot, itemName) {
  const key = normalizeItemName(itemName);
  if (!key) return 0;
  return inventoryRows(bot)
    .filter((i) => normalizeItemName(i?.name) === key)
    .reduce((acc, i) => acc + Number(i?.count || 0), 0);
}

function isCriticalItem(name) {
  const key = normalizeItemName(name);
  if (!key) return false;
  if (PROGRESSION_CRITICAL.has(key)) return true;
  if (/_pickaxe$/.test(key)) return true;
  if (/_sword$/.test(key)) return true;
  if (/^cooked_/.test(key)) return true;
  return false;
}

function findNearbyStashBlock(bot, radius = 12) {
  const mcData = require("minecraft-data")(bot.version);
  const blockIds = [
    mcData.blocksByName?.chest?.id,
    mcData.blocksByName?.trapped_chest?.id,
    mcData.blocksByName?.barrel?.id
  ].filter((n) => Number.isFinite(n));
  if (!blockIds.length || typeof bot.findBlock !== "function") return null;
  return bot.findBlock({
    matching: (b) => !!b && blockIds.includes(b.type),
    maxDistance: Math.max(1, Number(radius || 12))
  });
}

function stashStatus(bot, cfg = {}) {
  const rows = inventoryRows(bot);
  const critical = rows
    .filter((i) => isCriticalItem(i.name))
    .reduce((a, i) => a + Number(i.count || 0), 0);
  const nonCritical = rows
    .filter((i) => !isCriticalItem(i.name))
    .reduce((a, i) => a + Number(i.count || 0), 0);
  const stash = findNearbyStashBlock(bot, cfg.teamStashRadius || 12);
  return {
    stashFound: !!stash,
    criticalCount: critical,
    nonCriticalCount: nonCritical,
    stashPos: stash?.position || null
  };
}

async function giveItemToOwner(bot, ownerName, itemName, count = 1, log = () => {}) {
  const rows = inventoryRows(bot);
  const key = normalizeItemName(itemName);
  const needed = Math.max(1, Number(count || 1));
  let remaining = needed;

  if (!key) {
    return { ok: false, code: "invalid_item", reason: "invalid give item", given: 0 };
  }
  if (!rows.length) {
    return { ok: false, code: "empty_inventory", reason: "inventory empty", given: 0 };
  }

  let given = 0;
  for (const row of rows) {
    if (remaining <= 0) break;
    if (normalizeItemName(row?.name) !== key) continue;
    const tossCount = Math.min(Number(row.count || 0), remaining);
    if (tossCount <= 0) continue;
    try {
      await bot.toss(row.type, row.metadata || null, tossCount);
      remaining -= tossCount;
      given += tossCount;
    } catch (e) {
      log({ type: "team_stash_sync", action: "give_item_error", item: key, error: String(e) });
      break;
    }
  }

  log({
    type: "team_stash_sync",
    action: "give_item",
    owner: ownerName || null,
    item: key,
    requested: needed,
    given
  });

  if (given <= 0) {
    return { ok: false, code: "item_not_found", reason: `no ${key} to give`, given: 0 };
  }
  return { ok: true, given };
}

async function openStashContainer(bot, block) {
  if (!block) return null;
  if (typeof bot.openChest === "function") {
    try {
      return await bot.openChest(block);
    } catch {}
  }
  if (typeof bot.openContainer === "function") {
    try {
      return await bot.openContainer(block);
    } catch {}
  }
  return null;
}

async function stashNow(bot, cfg = {}, log = () => {}) {
  if (cfg.teamStashEnabled === false) {
    return { ok: false, code: "stash_disabled", reason: "team stash disabled", moved: 0 };
  }
  const stash = findNearbyStashBlock(bot, cfg.teamStashRadius || 12);
  if (!stash) {
    return { ok: false, code: "stash_not_found", reason: "no stash chest nearby", moved: 0 };
  }

  const container = await openStashContainer(bot, stash);
  if (!container) {
    return { ok: false, code: "stash_open_failed", reason: "failed opening stash", moved: 0 };
  }

  let moved = 0;
  try {
    for (const row of inventoryRows(bot)) {
      const itemName = normalizeItemName(row?.name);
      const itemCount = Number(row?.count || 0);
      if (!itemName || itemCount <= 0) continue;
      if (cfg.teamStashReservePolicy === "progression_first" && isCriticalItem(itemName)) continue;
      try {
        await container.deposit(row.type, row.metadata || null, itemCount);
        moved += itemCount;
      } catch {
        // chest full or invalid item; continue
      }
    }
  } finally {
    try {
      container.close();
    } catch {}
  }

  log({
    type: "team_stash_sync",
    action: "stash_now",
    moved,
    x: stash.position?.x ?? null,
    y: stash.position?.y ?? null,
    z: stash.position?.z ?? null
  });

  return { ok: true, moved };
}

module.exports = {
  inventoryCountByName,
  isCriticalItem,
  stashStatus,
  giveItemToOwner,
  stashNow
};
