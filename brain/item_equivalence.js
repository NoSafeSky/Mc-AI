function normalizeItemName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/^minecraft:/, "")
    .trim();
}

function woodFlexEnabled(cfg = {}) {
  return String(cfg.materialFlexPolicy || "inventory_first_any_wood").toLowerCase() === "inventory_first_any_wood";
}

function itemFamily(itemName) {
  const item = normalizeItemName(itemName);
  if (!item) return null;
  if (item === "log" || /(_log|_stem|_hyphae)$/.test(item)) return "log";
  if (item === "planks" || /_planks$/.test(item)) return "planks";
  return null;
}

function isWoodEquivalent(itemName) {
  return !!itemFamily(itemName);
}

function normalizePlanningItem(itemName, cfg = {}) {
  const item = normalizeItemName(itemName);
  if (!item) return "";
  if (!woodFlexEnabled(cfg)) return item;
  const family = itemFamily(item);
  return family || item;
}

function toCount(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function equivalentInventoryCount(inventory = {}, itemName, cfg = {}) {
  const item = normalizeItemName(itemName);
  if (!item) return 0;
  if (!woodFlexEnabled(cfg)) return toCount(inventory[item]);

  const family = itemFamily(item);
  if (!family) return toCount(inventory[item]);

  let total = 0;
  for (const [name, rawCount] of Object.entries(inventory || {})) {
    const key = normalizeItemName(name);
    if (!key) continue;
    if (key === item || itemFamily(key) === family) total += toCount(rawCount);
  }
  return total;
}

function consumeKey(inventory, key, needed) {
  const have = toCount(inventory[key]);
  if (have <= 0 || needed <= 0) return { taken: 0, left: needed };
  const taken = Math.min(have, needed);
  const left = needed - taken;
  const remaining = have - taken;
  inventory[key] = remaining;
  return { taken, left };
}

function equivalentInventoryConsume(inventory = {}, itemName, count, cfg = {}) {
  const item = normalizeItemName(itemName);
  const need = Math.max(0, Number(count || 0));
  if (!item || need <= 0) {
    return { remainder: need, consumed: [], usedEquivalent: false };
  }

  const consumed = [];
  if (!woodFlexEnabled(cfg)) {
    const { taken, left } = consumeKey(inventory, item, need);
    if (taken > 0) consumed.push({ item, count: taken });
    return { remainder: left, consumed, usedEquivalent: false };
  }

  const family = itemFamily(item);
  if (!family) {
    const { taken, left } = consumeKey(inventory, item, need);
    if (taken > 0) consumed.push({ item, count: taken });
    return { remainder: left, consumed, usedEquivalent: false };
  }

  let left = need;
  if (Object.prototype.hasOwnProperty.call(inventory, item)) {
    const res = consumeKey(inventory, item, left);
    left = res.left;
    if (res.taken > 0) consumed.push({ item, count: res.taken });
  }

  const familyKeys = Object.keys(inventory)
    .map((name) => normalizeItemName(name))
    .filter((key) => key && key !== item && itemFamily(key) === family)
    .sort();

  for (const key of familyKeys) {
    if (left <= 0) break;
    const res = consumeKey(inventory, key, left);
    left = res.left;
    if (res.taken > 0) consumed.push({ item: key, count: res.taken });
  }

  return {
    remainder: left,
    consumed,
    usedEquivalent: consumed.some((row) => row.item !== item)
  };
}

module.exports = {
  itemFamily,
  normalizePlanningItem,
  equivalentInventoryCount,
  equivalentInventoryConsume,
  isWoodEquivalent
};
