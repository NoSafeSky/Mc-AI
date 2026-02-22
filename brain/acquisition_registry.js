const { normalizeItemName } = require("./knowledge");
const { getBlockToolRequirement } = require("./block_compat");
const {
  normalizePlanningItem,
  equivalentInventoryCount,
  isWoodEquivalent
} = require("./item_equivalence");

const BLOCK_DROP_EQUIVALENTS = new Map([
  ["cobblestone", ["stone", "cobblestone"]],
  ["log", [
    "oak_log",
    "spruce_log",
    "birch_log",
    "jungle_log",
    "acacia_log",
    "dark_oak_log",
    "mangrove_log",
    "cherry_log",
    "crimson_stem",
    "warped_stem"
  ]],
  ["raw_iron", ["iron_ore", "deepslate_iron_ore"]],
  ["raw_gold", ["gold_ore", "deepslate_gold_ore"]],
  ["raw_copper", ["copper_ore", "deepslate_copper_ore"]],
  ["coal", ["coal_ore", "deepslate_coal_ore"]]
]);

const MOB_DROP_SOURCES = new Map([
  ["porkchop", ["pig"]],
  ["beef", ["cow"]],
  ["mutton", ["sheep"]],
  ["chicken", ["chicken"]],
  ["leather", ["cow", "horse"]],
  ["rotten_flesh", ["zombie"]],
  ["bone", ["skeleton"]],
  ["string", ["spider"]]
]);

const CROP_SOURCES = new Map([
  ["wheat", ["wheat"]],
  ["carrot", ["carrots"]],
  ["potato", ["potatoes"]],
  ["beetroot", ["beetroots"]]
]);

const SMELT_SOURCES = new Map([
  ["charcoal", { input: "log", station: "furnace" }],
  ["glass", { input: "sand", station: "furnace" }],
  ["baked_potato", { input: "potato", station: "furnace" }],
  ["cooked_beef", { input: "beef", station: "furnace" }],
  ["cooked_chicken", { input: "chicken", station: "furnace" }],
  ["iron_ingot", { input: "raw_iron", station: "furnace" }],
  ["gold_ingot", { input: "raw_gold", station: "furnace" }],
  ["copper_ingot", { input: "raw_copper", station: "furnace" }]
]);

const ANY_LOG_BLOCKS = [
  "oak_log",
  "spruce_log",
  "birch_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
  "mangrove_log",
  "cherry_log",
  "crimson_stem",
  "warped_stem"
];

function invCount(inventory, item, cfg = {}) {
  return Number(equivalentInventoryCount(inventory, item, cfg) || 0);
}

function exactInvCount(inventory, item) {
  return Number(inventory?.[normalizeItemName(item)] || 0);
}

function hasIngredientsInInventory(inventory, ingredients, cfg = {}) {
  return ingredients.every((ing) => invCount(inventory, ing.name, cfg) >= ing.count);
}

function isStoneTierCombatOrTool(item) {
  return /^stone_(sword|pickaxe|axe|shovel|hoe)$/.test(String(item || ""));
}

function ingredientSet(ingredients) {
  return new Set((ingredients || []).map((ing) => normalizeItemName(ing.name)));
}

function computeStoneCompatibility(item, rawIngredients, ctx) {
  const policy = (ctx?.cfg?.recipeVariantPolicy || "overworld_safe").toLowerCase();
  if (policy !== "overworld_safe") return { score: 0, components: {} };
  if (!isStoneTierCombatOrTool(item)) return { score: 0, components: {} };

  const names = ingredientSet(rawIngredients);
  const hasAllInInv = hasIngredientsInInventory(ctx?.snapshot?.inventory || {}, rawIngredients, ctx?.cfg || {});
  const resources = ctx?.snapshot?.nearbyResources || {};
  if (hasAllInInv) return { score: -50, components: { allInInventory: -50 } };

  let score = 0;
  const components = {};

  if (names.has("cobblestone")) {
    score -= 10;
    components.baseCobblestonePreference = -10;
  }
  if (names.has("cobbled_deepslate")) {
    score += 38;
    components.deepslatePenalty = 38;
  }
  if (names.has("blackstone")) {
    score += 48;
    components.blackstonePenalty = 48;
  }

  if (names.has("cobblestone") && resources.cobblestone?.available) {
    score -= 8;
    components.cobblestoneNearby = -8;
  }
  if (names.has("cobbled_deepslate") && resources.cobbled_deepslate?.available && !resources.cobblestone?.available) {
    score -= 10;
    components.deepslateNearbyFallback = -10;
  }
  if (names.has("blackstone") && resources.blackstone?.available && !resources.cobblestone?.available) {
    score -= 10;
    components.blackstoneNearbyFallback = -10;
  }

  return { score, components };
}

function computeWoodCompatibility(item, rawIngredients, normalizedIngredients, ctx) {
  const policy = String(ctx?.cfg?.materialFlexPolicy || "inventory_first_any_wood").toLowerCase();
  if (policy !== "inventory_first_any_wood") return { score: 0, components: {} };

  const inv = ctx?.snapshot?.inventory || {};
  const woodRaw = rawIngredients.filter((ing) => isWoodEquivalent(ing.name));
  if (!woodRaw.length) return { score: 0, components: {} };

  let exactSatisfied = 0;
  let familySatisfied = 0;
  for (const ing of woodRaw) {
    exactSatisfied += Math.min(exactInvCount(inv, ing.name), ing.count);
    familySatisfied += Math.min(invCount(inv, ing.name, ctx?.cfg || {}), ing.count);
  }

  let score = 0;
  const components = {};

  if (exactSatisfied > 0) {
    const bonus = -Math.min(24, exactSatisfied * 4);
    score += bonus;
    components.exactInventoryBonus = bonus;
  }
  if (familySatisfied > 0) {
    const bonus = -Math.min(18, familySatisfied * 3);
    score += bonus;
    components.familyInventoryBonus = bonus;
  }
  if (exactSatisfied === 0) {
    score += 14;
    components.speciesLockPenalty = 14;
  }

  if (String(item) === "stick" && ctx?.cfg?.preferBambooForSticks === false) {
    if (rawIngredients.some((ing) => normalizeItemName(ing.name) === "bamboo")) {
      score += 24;
      components.bambooPenalty = 24;
    }
  }

  if (hasIngredientsInInventory(inv, normalizedIngredients, ctx?.cfg || {})) {
    score -= 10;
    components.normalizedInventoryReady = -10;
  }

  return { score, components };
}

function scoreRecipeVariant(item, rawIngredients, normalizedIngredients, ctx) {
  const stone = computeStoneCompatibility(item, rawIngredients, ctx);
  const wood = computeWoodCompatibility(item, rawIngredients, normalizedIngredients, ctx);
  return {
    score: Number(stone.score || 0) + Number(wood.score || 0),
    components: {
      ...stone.components,
      ...wood.components
    }
  };
}

function recipeVariantId(ingredients) {
  return (ingredients || [])
    .map((ing) => `${normalizeItemName(ing.name)}x${ing.count}`)
    .sort()
    .join("+");
}

function mergeIngredients(ingredients) {
  const counts = new Map();
  for (const ing of ingredients || []) {
    const name = normalizeItemName(ing?.name);
    const count = Number(ing?.count || 0);
    if (!name || !Number.isFinite(count) || count <= 0) continue;
    counts.set(name, (counts.get(name) || 0) + count);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeRecipeIngredientsForPlanning(ingredients, cfg = {}, log = null, item = null) {
  const normalized = mergeIngredients(
    (ingredients || []).map((ing) => ({
      name: normalizePlanningItem(ing.name, cfg),
      count: Number(ing.count || 0)
    }))
  );

  const raw = mergeIngredients(ingredients || []);
  const changed = JSON.stringify(raw) !== JSON.stringify(normalized);
  if (changed && typeof log === "function") {
    log({
      type: "recipe_family_normalized",
      item: item || null,
      from: raw,
      to: normalized
    });
  }
  return normalized;
}

function stationSupported(ctx, station) {
  if (!station || station === "inventory") return true;
  const configured = Array.isArray(ctx?.cfg?.supportedStations) && ctx.cfg.supportedStations.length
    ? ctx.cfg.supportedStations
    : ["inventory", "crafting_table", "furnace", "smoker", "blast_furnace", "stonecutter"];
  return configured.includes(station);
}

function parseRecipeIngredients(recipe, mcData) {
  const counts = new Map();
  if (Array.isArray(recipe.inShape)) {
    for (const row of recipe.inShape) {
      if (!Array.isArray(row)) continue;
      for (const entry of row) {
        if (entry == null) continue;
        const id = Number(entry);
        if (!Number.isFinite(id)) continue;
        const item = mcData.items[id];
        if (!item?.name) continue;
        const key = normalizeItemName(item.name);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  } else if (Array.isArray(recipe.ingredients)) {
    for (const entry of recipe.ingredients) {
      if (entry == null) continue;
      const id = Number(entry);
      if (!Number.isFinite(id)) continue;
      const item = mcData.items[id];
      if (!item?.name) continue;
      const key = normalizeItemName(item.name);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function stationForRecipe(recipe) {
  if (Array.isArray(recipe.inShape)) {
    const height = recipe.inShape.length;
    const width = Math.max(0, ...recipe.inShape.map((r) => Array.isArray(r) ? r.length : 0));
    if (height > 2 || width > 2) return "crafting_table";
    return "inventory";
  }
  if (Array.isArray(recipe.ingredients)) {
    return recipe.ingredients.length > 4 ? "crafting_table" : "inventory";
  }
  return "inventory";
}

function recipeOutputsForPlanningItem(item, mcData) {
  if (item === "planks") {
    return Object.values(mcData.itemsByName || {})
      .filter((it) => it && typeof it.name === "string" && it.name.endsWith("_planks"));
  }
  const exact = mcData.itemsByName[item];
  return exact ? [exact] : [];
}

function getCraftOptions(item, count, ctx) {
  const mcData = ctx.mcData;
  const outputs = recipeOutputsForPlanningItem(item, mcData);
  if (!outputs.length) return [];

  const options = [];
  for (const outputItem of outputs) {
    const recipes = mcData.recipes[outputItem.id] || [];
    for (const recipe of recipes) {
      const outCount = Number(recipe?.result?.count || 1);
      if (outCount <= 0) continue;
      const runs = Math.max(1, Math.ceil(count / outCount));
      const rawIngredients = parseRecipeIngredients(recipe, mcData).map((ing) => ({
        name: ing.name,
        count: ing.count * runs
      }));
      if (!rawIngredients.length) continue;

      const ingredients = normalizeRecipeIngredientsForPlanning(rawIngredients, ctx.cfg || {}, ctx.log, item);
      if (!ingredients.length) continue;

      const station = stationForRecipe(recipe);
      if (!stationSupported(ctx, station)) continue;

      const scoreInfo = scoreRecipeVariant(item, rawIngredients, ingredients, ctx);
      const rawVariantId = recipeVariantId(rawIngredients);
      const variantId = item === "planks"
        ? `${normalizeItemName(outputItem.name)}:${rawVariantId}`
        : rawVariantId;
      const decompressionPenalty = ingredients.some((ing) => /_block$/.test(ing.name) && !/_block$/.test(item))
        ? 40
        : 0;
      const cost = 15 + ingredients.length * 3 + (station === "crafting_table" ? 6 : 0) + decompressionPenalty;

      const option = {
        provider: "craft_recipe",
        item,
        outputItem: normalizeItemName(outputItem.name),
        count,
        station,
        runs,
        outputCount: outCount,
        recipe,
        ingredients,
        rawIngredients,
        cost,
        compatibilityScore: Number(scoreInfo.score || 0),
        scoreBreakdown: scoreInfo.components || {},
        variantId
      };
      options.push(option);
      if (typeof ctx.log === "function") {
        ctx.log({
          type: "recipe_choice_scored",
          item,
          outputItem: option.outputItem,
          variantId,
          cost: option.cost,
          compatibilityScore: option.compatibilityScore,
          scoreBreakdown: option.scoreBreakdown,
          ingredients: option.ingredients,
          rawIngredients: option.rawIngredients
        });
      }
    }
  }

  return options;
}

function getSmeltOption(item, count) {
  const src = SMELT_SOURCES.get(item);
  if (!src) return null;
  return {
    provider: "smelt_recipe",
    item,
    count,
    station: src.station,
    input: src.input,
    inputCount: count,
    cost: 40 + count * 2
  };
}

function getGatherOptions(item, count, ctx) {
  if (ctx?.cfg?.autoGatherEnabled === false) return [];
  if (item === "planks") return [];
  const mcData = ctx.mcData;
  const options = [];

  let blockAliases = BLOCK_DROP_EQUIVALENTS.get(item) || [item];
  if (item === "log" || /(_log|_stem|_hyphae)$/.test(item)) {
    blockAliases = ANY_LOG_BLOCKS;
  }
  const normalizedAliases = blockAliases.map((name) => normalizeItemName(name));
  const preferredBlocks = item === "cobblestone"
    ? ["cobblestone", "stone"]
    : normalizedAliases;

  for (const blockName of blockAliases) {
    const block = mcData.blocksByName?.[blockName];
    if (!block) continue;
    const toolRequirement = getBlockToolRequirement(block, mcData);
    options.push({
      provider: "gather_block",
      item,
      count,
      blockNames: [normalizeItemName(blockName)],
      preferredBlocks,
      toolRequirement: toolRequirement || null,
      cost: 45 + count,
      compatibilityScore: 0,
      variantId: normalizeItemName(blockName)
    });
  }

  return options;
}

function getHarvestOption(item, count, ctx) {
  if (ctx?.cfg?.autoGatherEnabled === false) return null;
  const crops = CROP_SOURCES.get(item);
  if (!crops || !crops.length) return null;
  return {
    provider: "harvest_crop",
    item,
    count,
    cropBlocks: crops,
    cost: 42 + count,
    compatibilityScore: 0
  };
}

function getMobDropOption(item, count, ctx) {
  if (ctx?.cfg?.autoGatherEnabled === false) return null;
  const mobs = MOB_DROP_SOURCES.get(item);
  if (!mobs || !mobs.length) return null;
  const nearby = Object.values(ctx.bot.entities || {})
    .filter((e) => e?.name && mobs.includes(normalizeItemName(e.name)));
  const proximityPenalty = nearby.length ? 0 : 15;
  return {
    provider: "kill_mob_drop",
    item,
    count,
    mobs,
    cost: 55 + count * 2 + proximityPenalty,
    compatibilityScore: 0
  };
}

function getAcquisitionOptions(itemName, count, ctx) {
  const item = normalizePlanningItem(normalizeItemName(itemName), ctx?.cfg || {});
  const needed = Math.max(1, Number(count || 1));
  const options = [];
  const inInventory = invCount(ctx?.snapshot?.inventory || {}, item, ctx?.cfg || {});
  if (inInventory >= needed) {
    options.push({
      provider: "from_inventory",
      item,
      count: needed,
      available: inInventory,
      cost: 0,
      compatibilityScore: 0
    });
  }

  const optionCtx = {
    ...ctx,
    cfg: ctx?.cfg || {},
    snapshot: ctx?.snapshot || { inventory: {} }
  };

  options.push(...getCraftOptions(item, needed, optionCtx));
  const smelt = getSmeltOption(item, needed);
  if (smelt && !stationSupported(optionCtx, smelt.station)) {
    // station not available by configuration; ignore this route
  } else if (smelt) {
    options.push(smelt);
  }
  options.push(...getGatherOptions(item, needed, optionCtx));
  const harvest = getHarvestOption(item, needed, optionCtx);
  if (harvest) options.push(harvest);
  const killDrop = getMobDropOption(item, needed, optionCtx);
  if (killDrop) options.push(killDrop);

  if (!options.length) {
    return [{
      provider: "unsupported_source",
      item,
      count: needed,
      cost: Number.MAX_SAFE_INTEGER,
      compatibilityScore: 0
    }];
  }

  return options.sort((a, b) => {
    const aTotal = Number(a.cost || 0) + Number(a.compatibilityScore || 0);
    const bTotal = Number(b.cost || 0) + Number(b.compatibilityScore || 0);
    if (aTotal !== bTotal) return aTotal - bTotal;
    if (a.provider !== b.provider) return String(a.provider).localeCompare(String(b.provider));
    if ((a.variantId || "") !== (b.variantId || "")) return String(a.variantId || "").localeCompare(String(b.variantId || ""));
    return String(a.item).localeCompare(String(b.item));
  });
}

function chooseAcquisitionOption(itemName, count, ctx) {
  return getAcquisitionOptions(itemName, count, ctx)[0];
}

module.exports = {
  BLOCK_DROP_EQUIVALENTS,
  MOB_DROP_SOURCES,
  CROP_SOURCES,
  SMELT_SOURCES,
  parseRecipeIngredients,
  stationForRecipe,
  recipeVariantId,
  normalizeRecipeIngredientsForPlanning,
  scoreRecipeVariant,
  getAcquisitionOptions,
  chooseAcquisitionOption
};
