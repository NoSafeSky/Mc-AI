const STATIC_CRAFT_ALLOWS = new Set([
  "wooden_sword",
  "wooden_pickaxe",
  "wooden_axe",
  "wooden_shovel",
  "wooden_hoe",
  "stone_sword",
  "stone_pickaxe",
  "stone_axe",
  "stone_shovel",
  "stone_hoe",
  "stick",
  "planks",
  "crafting_table"
]);

const ITEM_ALIASES = new Map([
  ["wood sword", "wooden_sword"],
  ["wooden sword", "wooden_sword"],
  ["wood sword", "wooden_sword"],
  ["sword", "wooden_sword"],
  ["stone sword", "stone_sword"],
  ["wooden swords", "wooden_sword"],
  ["stone swords", "stone_sword"],

  ["wood pickaxe", "wooden_pickaxe"],
  ["wooden pickaxe", "wooden_pickaxe"],
  ["pickaxe", "wooden_pickaxe"],
  ["stone pickaxe", "stone_pickaxe"],
  ["wooden pickaxes", "wooden_pickaxe"],
  ["stone pickaxes", "stone_pickaxe"],
  ["pickaxes", "wooden_pickaxe"],

  ["wood axe", "wooden_axe"],
  ["wooden axe", "wooden_axe"],
  ["axe", "wooden_axe"],
  ["stone axe", "stone_axe"],
  ["wooden axes", "wooden_axe"],
  ["stone axes", "stone_axe"],

  ["wood shovel", "wooden_shovel"],
  ["wooden shovel", "wooden_shovel"],
  ["shovel", "wooden_shovel"],
  ["stone shovel", "stone_shovel"],
  ["wooden shovels", "wooden_shovel"],
  ["stone shovels", "stone_shovel"],

  ["wood hoe", "wooden_hoe"],
  ["wooden hoe", "wooden_hoe"],
  ["hoe", "wooden_hoe"],
  ["stone hoe", "stone_hoe"],
  ["wooden hoes", "wooden_hoe"],
  ["stone hoes", "stone_hoe"],

  ["sticks", "stick"],
  ["stick", "stick"],
  ["plank", "planks"],
  ["planks", "planks"],
  ["table", "crafting_table"],
  ["crafting table", "crafting_table"]
]);

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singularize(token) {
  const t = String(token || "");
  if (t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.endsWith("es")) return t.slice(0, -2);
  if (t.endsWith("s")) return t.slice(0, -1);
  return t;
}

function getMcData(version = "1.21.1") {
  try {
    return require("minecraft-data")(version);
  } catch {
    return null;
  }
}

function parseQuantity(raw, fallback = 1) {
  if (!raw) return fallback;
  if (raw === "a" || raw === "an") return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 64);
}

function resolveDynamicItemName(rawItem, version = "1.21.1") {
  const mcData = getMcData(version);
  if (!mcData?.itemsByName) return null;
  const normalized = normalizeText(rawItem);
  if (!normalized) return null;
  const underscored = normalized.replace(/\s+/g, "_");
  const singular = singularize(underscored);
  const candidates = [underscored, singular];

  for (const candidate of candidates) {
    if (mcData.itemsByName[candidate]) return candidate;
  }

  // Handle common "wood/stone/iron/diamond/netherite <tool>" phrases.
  const tierTool = /^(wood|wooden|stone|iron|gold|golden|diamond|netherite)\s+([a-z_]+)$/.exec(normalized);
  if (tierTool) {
    let tier = tierTool[1];
    if (tier === "wood") tier = "wooden";
    if (tier === "gold") tier = "golden";
    const base = singularize(tierTool[2]);
    const candidate = `${tier}_${base}`.replace(/\s+/g, "_");
    if (mcData.itemsByName[candidate]) return candidate;
  }

  return null;
}

function normalizeCraftItem(rawItem, version = "1.21.1") {
  const normalized = normalizeText(rawItem);
  if (!normalized) return null;
  if (STATIC_CRAFT_ALLOWS.has(normalized)) return normalized;
  if (ITEM_ALIASES.has(normalized)) return ITEM_ALIASES.get(normalized);

  if (normalized.startsWith("wooden ")) {
    const candidate = `wooden_${normalized.slice("wooden ".length).replace(/\s+/g, "_")}`;
    if (STATIC_CRAFT_ALLOWS.has(candidate)) return candidate;
  }
  if (normalized.startsWith("stone ")) {
    const candidate = `stone_${normalized.slice("stone ".length).replace(/\s+/g, "_")}`;
    if (STATIC_CRAFT_ALLOWS.has(candidate)) return candidate;
  }

  const underscored = normalized.replace(/\s+/g, "_");
  if (STATIC_CRAFT_ALLOWS.has(underscored)) return underscored;
  return resolveDynamicItemName(rawItem, version);
}

function parseCraftRequest(text, defaultCount = 1, version = "1.21.1") {
  const t = normalizeText(text);
  const craftMatch = /^(craft|make)\s+(?:me\s+)?(?:(\d+|a|an)\s+)?(.+)$/.exec(t);
  if (!craftMatch) return { isCraftPhrase: false, item: null, count: defaultCount, rawItem: null };

  let rawItem = craftMatch[3] || "";
  rawItem = rawItem
    .replace(/\b(for me|please|now)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const count = parseQuantity(craftMatch[2], defaultCount);
  const item = normalizeCraftItem(rawItem, version);
  return {
    isCraftPhrase: true,
    item,
    count,
    rawItem
  };
}

function isSupportedCraftItem(item, version = "1.21.1") {
  if (!item) return false;
  if (STATIC_CRAFT_ALLOWS.has(item)) return true;
  const mcData = getMcData(version);
  return !!mcData?.itemsByName?.[item];
}

module.exports = {
  SUPPORTED_CRAFT_ITEMS: STATIC_CRAFT_ALLOWS,
  parseCraftRequest,
  normalizeCraftItem,
  resolveDynamicItemName,
  isSupportedCraftItem
};
