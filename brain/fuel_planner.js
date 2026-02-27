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

function findFuelInventoryItem(bot, preferred = []) {
  const items = listInventoryItems(bot);
  const order = preferred.length ? preferred : FUEL_PRIORITY;
  for (const name of order) {
    const target = normalizeItemName(name);
    const found = items.find((it) => normalizeItemName(it?.name) === target && Number(it?.count || 0) > 0);
    if (found) return found;
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
  isFuelItemName
};
