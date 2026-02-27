const fs = require("fs");
const path = require("path");
const { normalizeItemName } = require("./knowledge");

const DB_CACHE = new Map();
const MANIFEST_LOAD_LOGGED = new Set();

const ALLOWED_STATIONS = new Set([
  "inventory",
  "crafting_table",
  "furnace",
  "smoker",
  "blast_furnace",
  "stonecutter",
  "smithing_table"
]);

const OVERWORLD_OUT_OF_SCOPE_PATTERNS = [
  /^netherite_/,
  /^elytra$/,
  /^end_crystal$/,
  /^ender_eye$/,
  /^ender_chest$/,
  /^beacon$/,
  /^respawn_anchor$/,
  /^lodestone$/,
  /^dragon_(egg|head|breath)$/,
  /^totem_of_undying$/,
  /^trident$/,
  /^nautilus_shell$/,
  /^heart_of_the_sea$/,
  /^conduit$/,
  /^phantom_membrane$/,
  /^ghast_tear$/,
  /^blaze_(rod|powder)$/,
  /^purpur_/,
  /^chorus_/,
  /^shulker_box$/,
  /_smithing_template$/,
  /^spawn_egg$/,
  /^echo_shard$/,
  /^disc_fragment_/,
  /^ancient_debris$/,
  /^nether_star$/
];

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
        const name = normalizeItemName(item.name);
        counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
  } else if (Array.isArray(recipe?.ingredients)) {
    for (const entry of recipe.ingredients) {
      if (entry == null) continue;
      const id = Number(entry);
      if (!Number.isFinite(id)) continue;
      const item = mcData.items[id];
      if (!item?.name) continue;
      const name = normalizeItemName(item.name);
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function stationForCraftRecipe(recipe) {
  if (Array.isArray(recipe?.inShape)) {
    const height = recipe.inShape.length;
    const width = Math.max(0, ...recipe.inShape.map((row) => Array.isArray(row) ? row.length : 0));
    return (height > 2 || width > 2) ? "crafting_table" : "inventory";
  }
  if (Array.isArray(recipe?.ingredients)) {
    return recipe.ingredients.length > 4 ? "crafting_table" : "inventory";
  }
  return "inventory";
}

function ingredientSignature(ingredients = []) {
  return ingredients
    .map((ing) => `${normalizeItemName(ing.name)}x${Number(ing.count || 0)}`)
    .sort()
    .join("+");
}

function buildStaticSmeltEntries() {
  const entries = [
    { outputItem: "charcoal", input: "log", station: "furnace" },
    { outputItem: "glass", input: "sand", station: "furnace" },
    { outputItem: "smooth_stone", input: "stone", station: "furnace" },
    { outputItem: "stone", input: "cobblestone", station: "furnace" },
    { outputItem: "cracked_stone_bricks", input: "stone_bricks", station: "furnace" },
    { outputItem: "cracked_deepslate_bricks", input: "deepslate_bricks", station: "furnace" },
    { outputItem: "cracked_deepslate_tiles", input: "deepslate_tiles", station: "furnace" },
    { outputItem: "baked_potato", input: "potato", station: "furnace" },
    { outputItem: "cooked_beef", input: "beef", station: "furnace" },
    { outputItem: "cooked_chicken", input: "chicken", station: "furnace" },
    { outputItem: "cooked_cod", input: "cod", station: "furnace" },
    { outputItem: "cooked_mutton", input: "mutton", station: "furnace" },
    { outputItem: "cooked_porkchop", input: "porkchop", station: "furnace" },
    { outputItem: "cooked_rabbit", input: "rabbit", station: "furnace" },
    { outputItem: "cooked_salmon", input: "salmon", station: "furnace" },
    { outputItem: "dried_kelp", input: "kelp", station: "furnace" },
    { outputItem: "brick", input: "clay_ball", station: "furnace" },
    { outputItem: "nether_brick", input: "netherrack", station: "furnace" },
    { outputItem: "lime_dye", input: "sea_pickle", station: "furnace" },
    { outputItem: "green_dye", input: "cactus", station: "furnace" },
    { outputItem: "terracotta", input: "clay", station: "furnace" },
    { outputItem: "copper_ingot", input: "raw_copper", station: "furnace" },
    { outputItem: "iron_ingot", input: "raw_iron", station: "furnace" },
    { outputItem: "gold_ingot", input: "raw_gold", station: "furnace" }
  ];
  return entries;
}

function buildStaticStonecutterEntries() {
  return [
    { outputItem: "stone_brick_slab", input: "stone_bricks", outputCount: 2, station: "stonecutter" },
    { outputItem: "stone_brick_stairs", input: "stone_bricks", station: "stonecutter" },
    { outputItem: "stone_brick_wall", input: "stone_bricks", station: "stonecutter" },
    { outputItem: "cobblestone_slab", input: "cobblestone", outputCount: 2, station: "stonecutter" },
    { outputItem: "cobblestone_stairs", input: "cobblestone", station: "stonecutter" },
    { outputItem: "cobblestone_wall", input: "cobblestone", station: "stonecutter" },
    { outputItem: "deepslate_tile_slab", input: "deepslate_tiles", outputCount: 2, station: "stonecutter" },
    { outputItem: "deepslate_tile_stairs", input: "deepslate_tiles", station: "stonecutter" },
    { outputItem: "deepslate_tile_wall", input: "deepslate_tiles", station: "stonecutter" },
    { outputItem: "polished_deepslate_slab", input: "polished_deepslate", outputCount: 2, station: "stonecutter" },
    { outputItem: "polished_deepslate_stairs", input: "polished_deepslate", station: "stonecutter" },
    { outputItem: "polished_deepslate_wall", input: "polished_deepslate", station: "stonecutter" }
  ];
}

function buildStaticSmithingEntries() {
  const toolsAndArmor = [
    "sword",
    "pickaxe",
    "axe",
    "shovel",
    "hoe",
    "helmet",
    "chestplate",
    "leggings",
    "boots"
  ];
  return toolsAndArmor.map((kind) => ({
    outputItem: `netherite_${kind}`,
    station: "smithing_table",
    ingredients: [
      { name: `diamond_${kind}`, count: 1 },
      { name: "netherite_ingot", count: 1 },
      { name: "netherite_upgrade_smithing_template", count: 1 }
    ]
  }));
}

function stationEnabled(station, opts = {}) {
  if (!station || station === "inventory") return true;
  const configured = Array.isArray(opts.stationExecutionEnabled) && opts.stationExecutionEnabled.length
    ? opts.stationExecutionEnabled
    : ["inventory", "crafting_table", "furnace", "smoker", "blast_furnace", "stonecutter", "smithing_table"];
  return configured.includes(station);
}

function processInScope(processType, opts = {}) {
  const scope = String(opts.recipeExecutionScope || "craft_smelt_stations").toLowerCase();
  if (scope === "craft_only") return processType === "craft";
  if (scope === "craft_smelt") return processType === "craft" || processType === "smelt";
  return true;
}

function coverageMode(opts = {}) {
  return String(opts.craftCoverageMode || opts.coverageMode || "legacy").toLowerCase();
}

function coverageManifestVersion(opts = {}) {
  return String(opts.craftRecipeManifestVersion || opts.manifestVersion || "1.21.1-overworld-v1");
}

function isItemSupportedInCoverage(itemName, opts = {}) {
  const mode = coverageMode(opts);
  if (mode !== "overworld_v1") return true;
  const name = normalizeItemName(itemName);
  if (!name) return false;
  return !OVERWORLD_OUT_OF_SCOPE_PATTERNS.some((re) => re.test(name));
}

function defaultManifestPath(opts = {}) {
  if (opts.manifestPath) return path.resolve(opts.manifestPath);
  return path.join(__dirname, "data", "recipes", "overworld_1_21_1.json");
}

function addEntry(state, entry) {
  if (!entry?.outputItem || !Array.isArray(entry.ingredients) || !entry.ingredients.length) return;
  const outputItem = normalizeItemName(entry.outputItem);
  if (!outputItem) return;
  const normalizedIngredients = entry.ingredients
    .map((ing) => ({
      name: normalizeItemName(ing.name),
      count: Math.max(1, Number(ing.count || 1))
    }))
    .filter((ing) => !!ing.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!normalizedIngredients.length) return;

  const outputCount = Math.max(1, Number(entry.outputCount || 1));
  const station = normalizeItemName(entry.station || "inventory");
  const processType = normalizeItemName(entry.processType || "craft");
  const variantId = entry.variantId || `${processType}:${outputItem}:${ingredientSignature(normalizedIngredients)}`;
  const scope = normalizeItemName(entry.scope || "all");

  const record = {
    outputItem,
    outputCount,
    station,
    processType,
    ingredients: normalizedIngredients,
    variantId,
    scope
  };

  if (!state.entriesByOutput.has(outputItem)) {
    state.entriesByOutput.set(outputItem, []);
  }
  state.entriesByOutput.get(outputItem).push(record);

  if (outputItem.endsWith("_planks")) {
    if (!state.entriesByOutput.has("planks")) state.entriesByOutput.set("planks", []);
    state.entriesByOutput.get("planks").push(record);
  }

  state.variantsById.set(variantId, record);
}

function rejectManifest(log, detail) {
  if (typeof log === "function") {
    log({
      type: "recipe_manifest_reject",
      ...detail
    });
  }
}

function loadManifestEntries(version, mcData, opts = {}) {
  const manifestPath = defaultManifestPath(opts);
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    rejectManifest(opts.log, {
      manifestPath,
      reason: `manifest_read_error:${String(e?.message || e)}`
    });
    throw new Error(`recipe manifest read failed: ${manifestPath}`);
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    rejectManifest(opts.log, {
      manifestPath,
      reason: "manifest_invalid_shape"
    });
    throw new Error(`recipe manifest invalid shape: ${manifestPath}`);
  }

  const entries = [];
  for (let i = 0; i < parsed.entries.length; i += 1) {
    const row = parsed.entries[i];
    const station = normalizeItemName(row?.station);
    const processType = normalizeItemName(row?.processType);
    const outputItem = normalizeItemName(row?.outputItem);
    const scope = normalizeItemName(row?.scope || "overworld");
    const ingredients = Array.isArray(row?.ingredients)
      ? row.ingredients.map((ing) => ({
        name: normalizeItemName(ing?.name),
        count: Math.max(1, Number(ing?.count || 1))
      }))
      : [];

    const fail = (reason) => {
      rejectManifest(opts.log, {
        manifestPath,
        index: i,
        reason,
        entry: row || null
      });
      throw new Error(`recipe manifest invalid entry at index ${i}: ${reason}`);
    };

    if (!outputItem) fail("missing_output_item");
    if (!mcData.itemsByName?.[outputItem]) fail(`unknown_output_item:${outputItem}`);
    if (!ALLOWED_STATIONS.has(station)) fail(`invalid_station:${station}`);
    if (!["smelt", "stonecut", "smithing", "craft"].includes(processType)) fail(`invalid_process_type:${processType}`);
    if (!Array.isArray(ingredients) || !ingredients.length) fail("missing_ingredients");
    for (const ing of ingredients) {
      if (!ing.name) fail("missing_ingredient_name");
      if (!mcData.itemsByName?.[ing.name]) fail(`unknown_ingredient:${ing.name}`);
      if (!Number.isFinite(ing.count) || ing.count <= 0) fail(`invalid_ingredient_count:${ing.name}`);
    }
    if (scope !== "overworld" && scope !== "all") fail(`invalid_scope:${scope}`);

    entries.push({
      outputItem,
      outputCount: Math.max(1, Number(row?.outputCount || 1)),
      processType,
      station,
      ingredients,
      variantId: String(row?.variantId || `${processType}:${outputItem}:${ingredientSignature(ingredients)}`),
      scope
    });
  }

  const key = `${version}|${coverageMode(opts)}|${coverageManifestVersion(opts)}|${manifestPath}`;
  if (typeof opts.log === "function" && !MANIFEST_LOAD_LOGGED.has(key)) {
    MANIFEST_LOAD_LOGGED.add(key);
    opts.log({
      type: "recipe_manifest_loaded",
      version,
      coverageMode: coverageMode(opts),
      manifestVersion: coverageManifestVersion(opts),
      manifestPath,
      entryCount: entries.length
    });
  }
  return entries;
}

function buildRecipeDb(version = "1.21.1", opts = {}) {
  const key = String(version || "1.21.1");
  const mode = coverageMode(opts);
  const manifestVersion = coverageManifestVersion(opts);
  const manifestPath = mode === "overworld_v1" ? defaultManifestPath(opts) : "";
  const cacheKey = `${key}|${mode}|${manifestVersion}|${manifestPath}`;
  if (DB_CACHE.has(cacheKey)) return DB_CACHE.get(cacheKey);

  const mcData = require("minecraft-data")(key);
  const state = {
    version: key,
    coverageMode: mode,
    manifestVersion,
    mcData,
    entriesByOutput: new Map(),
    variantsById: new Map()
  };

  for (const [itemName, itemInfo] of Object.entries(mcData.itemsByName || {})) {
    const outputItem = normalizeItemName(itemName);
    if (mode === "overworld_v1" && !isItemSupportedInCoverage(outputItem, opts)) continue;
    const recipes = mcData.recipes?.[itemInfo.id] || [];
    for (const recipe of recipes) {
      const ingredients = parseRecipeIngredients(recipe, mcData);
      if (!ingredients.length) continue;
      const station = stationForCraftRecipe(recipe);
      const outputCount = Number(recipe?.result?.count || 1) || 1;
      const variantId = `craft:${outputItem}:${ingredientSignature(ingredients)}`;
      addEntry(state, {
        outputItem,
        outputCount,
        station,
        processType: "craft",
        ingredients,
        variantId,
        scope: mode === "overworld_v1" ? "overworld" : "all"
      });
    }
  }

  if (mode === "overworld_v1") {
    const manifestEntries = loadManifestEntries(key, mcData, opts);
    for (const entry of manifestEntries) {
      if (!isItemSupportedInCoverage(entry.outputItem, opts)) continue;
      addEntry(state, entry);
    }
  } else {
    for (const src of buildStaticSmeltEntries()) {
      addEntry(state, {
        outputItem: src.outputItem,
        outputCount: src.outputCount || 1,
        station: src.station || "furnace",
        processType: "smelt",
        ingredients: [{ name: src.input, count: src.inputCount || 1 }],
        variantId: `smelt:${normalizeItemName(src.outputItem)}:${normalizeItemName(src.input)}`,
        scope: "all"
      });
    }

    for (const src of buildStaticStonecutterEntries()) {
      addEntry(state, {
        outputItem: src.outputItem,
        outputCount: src.outputCount || 1,
        station: src.station || "stonecutter",
        processType: "stonecut",
        ingredients: [{ name: src.input, count: 1 }],
        variantId: `stonecut:${normalizeItemName(src.outputItem)}:${normalizeItemName(src.input)}`,
        scope: "all"
      });
    }

    for (const src of buildStaticSmithingEntries()) {
      addEntry(state, {
        outputItem: src.outputItem,
        outputCount: 1,
        station: "smithing_table",
        processType: "smithing",
        ingredients: src.ingredients,
        variantId: `smithing:${normalizeItemName(src.outputItem)}:${ingredientSignature(src.ingredients)}`,
        scope: "all"
      });
    }
  }

  for (const [, entries] of state.entriesByOutput.entries()) {
    entries.sort((a, b) => {
      if (a.processType !== b.processType) return a.processType.localeCompare(b.processType);
      if (a.station !== b.station) return a.station.localeCompare(b.station);
      if (a.variantId !== b.variantId) return a.variantId.localeCompare(b.variantId);
      return 0;
    });
  }

  const db = {
    version: key,
    coverageMode: mode,
    manifestVersion,
    mcData,
    entriesByOutput: state.entriesByOutput,
    variantsById: state.variantsById
  };
  DB_CACHE.set(cacheKey, db);
  return db;
}

function getRecipeVariants(outputItem, opts = {}) {
  const item = normalizeItemName(outputItem);
  if (!item) return [];
  if (!isItemSupportedInCoverage(item, opts)) return [];
  const db = buildRecipeDb(opts.version || "1.21.1", opts);
  const mode = coverageMode(opts);
  const all = db.entriesByOutput.get(item) || [];
  return all
    .filter((entry) => processInScope(entry.processType, opts))
    .filter((entry) => stationEnabled(entry.station, opts))
    .filter((entry) => mode !== "overworld_v1" || entry.scope === "overworld" || entry.scope === "all")
    .map((entry) => ({
      ...entry,
      ingredients: entry.ingredients.map((ing) => ({ ...ing }))
    }));
}

function getStationForVariant(variantId, opts = {}) {
  const id = String(variantId || "").trim();
  if (!id) return null;
  const db = buildRecipeDb(opts.version || "1.21.1", opts);
  return db.variantsById.get(id)?.station || null;
}

function getIngredientGraph(outputItem, count = 1, opts = {}) {
  const item = normalizeItemName(outputItem);
  const targetCount = Math.max(1, Number(count || 1));
  if (!item) return { item: null, count: 0, nodeCount: 0, root: null };

  const visited = new Set();
  let nodeCount = 0;
  const maxDepth = Math.max(1, Number(opts.maxDepth || 8));

  function walk(name, needCount, depth) {
    nodeCount += 1;
    const key = `${name}:${needCount}:${depth}`;
    if (visited.has(key) || depth >= maxDepth) {
      return {
        item: name,
        count: needCount,
        variantId: null,
        station: null,
        processType: null,
        ingredients: [],
        children: []
      };
    }
    visited.add(key);
    const variants = getRecipeVariants(name, opts);
    if (!variants.length) {
      return {
        item: name,
        count: needCount,
        variantId: null,
        station: null,
        processType: null,
        ingredients: [],
        children: []
      };
    }

    const chosen = variants[0];
    const runs = Math.max(1, Math.ceil(needCount / Math.max(1, chosen.outputCount || 1)));
    const ingredients = chosen.ingredients.map((ing) => ({
      name: ing.name,
      count: ing.count * runs
    }));
    return {
      item: name,
      count: needCount,
      variantId: chosen.variantId,
      station: chosen.station,
      processType: chosen.processType,
      ingredients,
      children: ingredients.map((ing) => walk(ing.name, ing.count, depth + 1))
    };
  }

  return {
    item,
    count: targetCount,
    nodeCount,
    root: walk(item, targetCount, 0)
  };
}

module.exports = {
  buildRecipeDb,
  getRecipeVariants,
  getStationForVariant,
  getIngredientGraph,
  isItemSupportedInCoverage
};
