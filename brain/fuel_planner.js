const { normalizeItemName } = require("./knowledge");

const FUEL_PRIORITY = [
  "coal",
  "charcoal",
  "coal_block",
  "blaze_rod",
  "dried_kelp_block",
  "lava_bucket",
  "stick",
  "planks",
  "log"
];

const FUELS = new Set(FUEL_PRIORITY);
const FUEL_SMELT_VALUE = Object.freeze({
  coal: 8,
  charcoal: 8,
  coal_block: 80,
  blaze_rod: 12,
  dried_kelp_block: 20,
  lava_bucket: 100,
  stick: 0.5,
  planks: 1.5,
  log: 1.5
});

function listInventoryItems(bot) {
  if (!bot?.inventory) return [];
  if (typeof bot.inventory.items === "function") {
    const listed = bot.inventory.items();
    if (Array.isArray(listed)) return listed;
  }
  const slots = Array.isArray(bot.inventory.slots) ? bot.inventory.slots.filter(Boolean) : [];
  if (slots.length) return slots;
  return [];
}

function findFuelInventoryItem(bot, preferred = [], options = {}) {
  const items = listInventoryItems(bot);
  const order = preferred.length ? preferred : FUEL_PRIORITY;
  const minSmelts = Math.max(0, Number(options?.minSmelts || 0));
  const matches = (itemName, prefName) => {
    const item = normalizeItemName(itemName);
    const pref = normalizeItemName(prefName);
    if (!item || !pref) return false;
    if (pref === "log") return /(_log|_stem|_hyphae)$/.test(item);
    if (pref === "planks") return /_planks$/.test(item);
    if (pref.endsWith("_log") || pref.endsWith("_stem") || pref.endsWith("_hyphae")) {
      return /(_log|_stem|_hyphae)$/.test(item);
    }
    if (pref.endsWith("_planks")) return /_planks$/.test(item);
    return item === pref;
  };
  for (const name of order) {
    const matchingRows = items
      .filter((it) => matches(it?.name, name) && Number(it?.count || 0) > 0)
      .sort((a, b) => Number(b?.count || 0) - Number(a?.count || 0));
    if (!matchingRows.length) continue;
    if (minSmelts > 0) {
      const burn = fuelSmeltValue(name || matchingRows[0]?.name);
      const totalCount = matchingRows.reduce((sum, row) => sum + Number(row?.count || 0), 0);
      const capacity = burn * totalCount;
      if (!Number.isFinite(capacity) || capacity < minSmelts) continue;
    }
    return matchingRows[0];
  }
  if (minSmelts > 0) {
    for (const name of order) {
      const found = items.find((it) => matches(it?.name, name) && Number(it?.count || 0) > 0);
      if (found) return found;
    }
  }
  return null;
}

function normalizeFuelPolicy(policy) {
  const p = String(policy || "inventory_first_then_charcoal_then_coal").toLowerCase();
  if (!p) return "inventory_first_then_charcoal_then_coal";
  return p;
}

function fuelPlan(cfg = {}, outputCount = 1) {
  const policy = normalizeFuelPolicy(cfg.fuelPolicy);
  const count = Math.max(1, Number(outputCount || 1));
  const preferred = [];

  // This bot uses one input per smelt operation, so one generic fuel item is enough in most paths.
  if (policy === "inventory_first_then_charcoal_then_coal") {
    preferred.push("charcoal", "coal", "coal_block", "blaze_rod", "dried_kelp_block", "planks", "log", "stick");
  } else {
    preferred.push("coal", "charcoal", "coal_block", "blaze_rod", "dried_kelp_block", "planks", "log", "stick");
  }

  return {
    requiredFuelUnits: count,
    preferred
  };
}

function fuelSmeltValue(name) {
  const key = normalizeItemName(name);
  if (!key) return 0;
  if (Object.prototype.hasOwnProperty.call(FUEL_SMELT_VALUE, key)) {
    return Number(FUEL_SMELT_VALUE[key] || 0);
  }
  if (/(_log|_stem|_hyphae)$/.test(key)) return Number(FUEL_SMELT_VALUE.log);
  if (/_planks$/.test(key)) return Number(FUEL_SMELT_VALUE.planks);
  return 0;
}

function requiredFuelItemCount(name, smeltOperations = 1) {
  const burn = fuelSmeltValue(name);
  if (!Number.isFinite(burn) || burn <= 0) return Number.POSITIVE_INFINITY;
  const ops = Math.max(1, Number(smeltOperations || 1));
  return Math.max(1, Math.ceil(ops / burn));
}

function isFuelItemName(name) {
  const item = normalizeItemName(name);
  if (FUELS.has(item)) return true;
  if (/(_log|_stem|_hyphae)$/.test(item)) return true;
  if (/_planks$/.test(item)) return true;
  return false;
}

module.exports = {
  fuelPlan,
  findFuelInventoryItem,
  isFuelItemName,
  fuelSmeltValue,
  requiredFuelItemCount
};
