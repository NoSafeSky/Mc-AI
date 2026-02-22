const { normalizeItemName } = require("./knowledge");
const { getBlockToolRequirement } = require("./block_compat");
const {
  normalizePlanningItem,
  equivalentInventoryCount,
  isWoodEquivalent
} = require("./item_equivalence");
const { getRecipeVariants } = require("./recipe_db");

const BLOCK_DROP_EQUIVALENTS = new Map([
  ["cobblestone", ["stone", "cobblestone", "cobbled_deepslate", "blackstone"]],
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
  ["coal", ["coal_ore", "deepslate_coal_ore"]],
  ["diamond", ["diamond_ore", "deepslate_diamond_ore"]],
  ["emerald", ["emerald_ore", "deepslate_emerald_ore"]],
  ["redstone", ["redstone_ore", "deepslate_redstone_ore"]],
  ["lapis_lazuli", ["lapis_ore", "deepslate_lapis_ore"]]
]);

const ANY_LOG_BLOCKS = BLOCK_DROP_EQUIVALENTS.get("log") || [];

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
  let score = 0;
  const components = {};

  if (String(item) === "stick" && ctx?.cfg?.preferBambooForSticks === false) {
    if (rawIngredients.some((ing) => normalizeItemName(ing.name) === "bamboo")) {
      score += 120;
      components.bambooPenalty = 120;
    }
  }

  if (!woodRaw.length) {
    return { score, components };
  }

  let exactSatisfied = 0;
  let familySatisfied = 0;
  for (const ing of woodRaw) {
    exactSatisfied += Math.min(exactInvCount(inv, ing.name), ing.count);
    familySatisfied += Math.min(invCount(inv, ing.name, ctx?.cfg || {}), ing.count);
  }

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
  const configured = Array.isArray(ctx?.cfg?.stationExecutionEnabled) && ctx.cfg.stationExecutionEnabled.length
    ? ctx.cfg.stationExecutionEnabled
    : (Array.isArray(ctx?.cfg?.supportedStations) && ctx.cfg.supportedStations.length
      ? ctx.cfg.supportedStations
      : ["inventory", "crafting_table", "furnace", "smoker", "blast_furnace", "stonecutter", "smithing_table"]);
  return configured.includes(station);
}

function parseRecipeIngredients(recipe, mcData) {
  const counts = new Map();
  if (Array.isArray(recipe?.inShape)) {
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
  } else if (Array.isArray(recipe?.ingredients)) {
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
  if (Array.isArray(recipe?.inShape)) {
    const height = recipe.inShape.length;
    const width = Math.max(0, ...recipe.inShape.map((r) => Array.isArray(r) ? r.length : 0));
    return (height > 2 || width > 2) ? "crafting_table" : "inventory";
  }
  if (Array.isArray(recipe?.ingredients)) {
    return recipe.ingredients.length > 4 ? "crafting_table" : "inventory";
  }
  return "inventory";
}

function getRecipeOptions(item, count, ctx) {
  const version = ctx?.bot?.version || ctx?.cfg?.version || "1.21.1";
  const variants = getRecipeVariants(item, {
    version,
    recipeExecutionScope: ctx?.cfg?.recipeExecutionScope || "craft_smelt_stations",
    stationExecutionEnabled: ctx?.cfg?.stationExecutionEnabled || ctx?.cfg?.supportedStations
  });

  const options = [];
  for (const variant of variants) {
    if (!stationSupported(ctx, variant.station)) continue;
    const runs = Math.max(1, Math.ceil(count / Math.max(1, Number(variant.outputCount || 1))));
    const rawIngredients = (variant.ingredients || []).map((ing) => ({
      name: normalizeItemName(ing.name),
      count: Math.max(1, Number(ing.count || 1)) * runs
    }));
    if (!rawIngredients.length) continue;

    const ingredients = normalizeRecipeIngredientsForPlanning(rawIngredients, ctx.cfg || {}, ctx.log, item);
    if (!ingredients.length) continue;

    const scoreInfo = scoreRecipeVariant(item, rawIngredients, ingredients, ctx);
    const decompressionPenalty = ingredients.some((ing) => /_block$/.test(ing.name) && !/_block$/.test(item))
      ? 40
      : 0;

    let baseCost = 20 + ingredients.length * 4 + decompressionPenalty;
    if (variant.processType === "smelt") baseCost = 40 + count * 2;
    if (variant.processType === "stonecut") baseCost = 24 + count;
    if (variant.processType === "smithing") baseCost = 60 + count * 2;
    if (variant.station === "crafting_table") baseCost += 6;

    const common = {
      item,
      outputItem: variant.outputItem || item,
      count,
      station: variant.station || "inventory",
      runs,
      outputCount: Math.max(1, Number(variant.outputCount || 1)),
      ingredients,
      rawIngredients,
      cost: baseCost,
      compatibilityScore: Number(scoreInfo.score || 0),
      scoreBreakdown: scoreInfo.components || {},
      variantId: variant.variantId
    };

    if (variant.processType === "smelt") {
      const input = rawIngredients[0];
      options.push({
        provider: "smelt_recipe",
        processType: "smelt",
        input: input?.name,
        inputCount: input?.count || count,
        ...common
      });
    } else if (variant.processType === "stonecut" || variant.processType === "smithing") {
      options.push({
        provider: "station_recipe",
        processType: variant.processType,
        ...common
      });
    } else {
      options.push({
        provider: "craft_recipe",
        processType: "craft",
        recipe: null,
        ...common
      });
    }

    if (typeof ctx.log === "function") {
      ctx.log({
        type: "recipe_choice_scored",
        item,
        outputItem: common.outputItem,
        variantId: common.variantId,
        processType: variant.processType,
        station: common.station,
        cost: common.cost,
        compatibilityScore: common.compatibilityScore,
        scoreBreakdown: common.scoreBreakdown,
        ingredients: common.ingredients,
        rawIngredients: common.rawIngredients
      });
    }
  }

  return options;
}

function getGatherOptions(item, count, ctx) {
  if (ctx?.cfg?.autoGatherEnabled === false) return [];
  if (item === "planks") return [];

  const mcData = ctx.mcData;
  let blockAliases = BLOCK_DROP_EQUIVALENTS.get(item) || [item];
  if (item === "log" || /(_log|_stem|_hyphae)$/.test(item)) {
    blockAliases = ANY_LOG_BLOCKS;
  }

  const blockNames = blockAliases
    .map((name) => normalizeItemName(name))
    .filter((name) => !!mcData.blocksByName?.[name]);
  if (!blockNames.length) return [];

  const preferredBlocks = item === "cobblestone"
    ? ["cobblestone", "stone", "cobbled_deepslate", "blackstone"].filter((name) => blockNames.includes(name))
    : [...blockNames];

  const preferredFirst = preferredBlocks[0] || blockNames[0];
  const toolRequirement = preferredFirst
    ? getBlockToolRequirement(mcData.blocksByName[preferredFirst], mcData)
    : null;

  return [{
    provider: "gather_block",
    item,
    count,
    blockNames,
    preferredBlocks,
    toolRequirement: toolRequirement || null,
    cost: 45 + count,
    compatibilityScore: 0,
    variantId: `gather:${item}:${preferredFirst || blockNames[0]}`
  }];
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
  const nearby = Object.values(ctx.bot?.entities || {})
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
    snapshot: ctx?.snapshot || { inventory: {}, nearbyResources: {} }
  };

  options.push(...getRecipeOptions(item, needed, optionCtx));
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
    if ((a.provider || "") !== (b.provider || "")) return String(a.provider || "").localeCompare(String(b.provider || ""));
    if ((a.variantId || "") !== (b.variantId || "")) return String(a.variantId || "").localeCompare(String(b.variantId || ""));
    return String(a.item || "").localeCompare(String(b.item || ""));
  });
}

function chooseAcquisitionOption(itemName, count, ctx) {
  return getAcquisitionOptions(itemName, count, ctx)[0];
}

module.exports = {
  BLOCK_DROP_EQUIVALENTS,
  MOB_DROP_SOURCES,
  CROP_SOURCES,
  parseRecipeIngredients,
  stationForRecipe,
  recipeVariantId,
  normalizeRecipeIngredientsForPlanning,
  scoreRecipeVariant,
  getAcquisitionOptions,
  chooseAcquisitionOption
};
