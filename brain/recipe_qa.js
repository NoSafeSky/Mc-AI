const { normalizeCraftItem, resolveDynamicItemName } = require("./crafting_catalog");
const {
  parseRecipeIngredients,
  stationForRecipe,
  recipeVariantId,
  normalizeRecipeIngredientsForPlanning,
  scoreRecipeVariant
} = require("./acquisition_registry");
const { normalizeItemName } = require("./knowledge");
const { getRecipeVariants } = require("./recipe_db");

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isRecipeQuestion(text) {
  const t = normalizeText(text);
  if (!t) return false;
  return (
    /\bhow\s+(?:do\s+i|to)\s+(?:craft|make)\b/.test(t) ||
    /\bhow\s+can\s+i\s+(?:craft|make)\b/.test(t) ||
    /\brecipe\s+for\b/.test(t) ||
    /\bgive\s+me\s+(?:a\s+)?recipe\s+for\b/.test(t)
  );
}

function extractRecipeTarget(text) {
  const t = normalizeText(text);
  const patterns = [
    /\bhow\s+(?:do\s+i|to)\s+(?:craft|make)\s+(.+)$/,
    /\bhow\s+can\s+i\s+(?:craft|make)\s+(.+)$/,
    /\brecipe\s+for\s+(.+)$/,
    /\bgive\s+me\s+(?:a\s+)?recipe\s+for\s+(.+)$/
  ];

  for (const re of patterns) {
    const m = re.exec(t);
    if (!m) continue;
    const raw = String(m[1] || "")
      .replace(/\b(please|now|in minecraft)\b/g, "")
      .replace(/\bfrom\s+[a-z_]+\b/g, "")
      .replace(/^(a|an|the)\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (raw) return raw;
  }
  return null;
}

function canonicalRecipeItem(rawItem, version) {
  if (!rawItem) return null;
  const fromCatalog = normalizeCraftItem(rawItem, version);
  if (fromCatalog) return normalizeItemName(fromCatalog);
  const dynamic = resolveDynamicItemName(rawItem, version);
  return dynamic ? normalizeItemName(dynamic) : null;
}

function stationLabel(station) {
  if (!station || station === "inventory") return "2x2 inventory grid";
  return station;
}

function ingredientsToText(ingredients) {
  return ingredients
    .map((ing) => `${ing.count} ${ing.name}`)
    .join(", ");
}

function buildRecipeReply(item, selected, variants) {
  const ingredientText = ingredientsToText(selected.ingredients);
  const stationText = stationLabel(selected.station);
  const processPrefix = selected.processType === "smelt"
    ? "smelt"
    : (selected.processType === "smithing" ? "smith" : (selected.processType === "stonecut" ? "stonecut" : "recipe"));
  if (variants.length > 1) {
    const other = variants
      .filter((v) => v.variantId !== selected.variantId)
      .map((v) => v.variantId)
      .slice(0, 2)
      .join(" | ");
    if (other) {
      return `${processPrefix} ${item}: ${ingredientText} at ${stationText}. variants: ${other}`;
    }
  }
  return `${processPrefix} ${item}: ${ingredientText} at ${stationText}.`;
}

function defaultSnapshot(snapshot = null) {
  if (snapshot && typeof snapshot === "object") return snapshot;
  return {
    inventory: {},
    inventoryFamilies: { log: 0, planks: 0 },
    nearbyResources: {}
  };
}

function resolveRecipeAnswer(text, botVersion = "1.21.1", cfg = {}, snapshot = null) {
  const rawTarget = extractRecipeTarget(text);
  if (!rawTarget) {
    return { ok: false, reason: "recipe_target_missing" };
  }

  const item = canonicalRecipeItem(rawTarget, botVersion);
  if (!item) {
    return { ok: false, reason: "recipe_item_unknown", rawTarget };
  }

  const mcData = require("minecraft-data")(botVersion);
  const itemInfo = mcData.itemsByName?.[item];
  if (!itemInfo) {
    return { ok: false, reason: "recipe_item_unknown", item, rawTarget };
  }

  const ctx = { cfg, snapshot: defaultSnapshot(snapshot) };
  let variants = getRecipeVariants(item, {
    version: botVersion,
    recipeExecutionScope: cfg.recipeExecutionScope || "craft_smelt_stations",
    stationExecutionEnabled: cfg.stationExecutionEnabled || cfg.supportedStations
  })
    .map((variant) => {
      const rawIngredients = (variant.ingredients || []).map((ing) => ({
        name: normalizeItemName(ing.name),
        count: Number(ing.count || 1)
      }));
      const ingredients = normalizeRecipeIngredientsForPlanning(rawIngredients, cfg || {});
      const scoreInfo = scoreRecipeVariant(item, rawIngredients, ingredients, ctx);
      return {
        station: variant.station || "inventory",
        processType: variant.processType || "craft",
        ingredients: rawIngredients,
        normalizedIngredients: ingredients,
        variantId: variant.variantId || recipeVariantId(rawIngredients),
        score: Number(scoreInfo.score || 0)
      };
    })
    .filter((v) => v.ingredients.length > 0);

  // Fallback for older snapshots that only include crafting recipes.
  if (!variants.length) {
    const recipes = mcData.recipes?.[itemInfo.id] || [];
    variants = recipes
      .map((recipe) => {
        const rawIngredients = parseRecipeIngredients(recipe, mcData);
        const ingredients = normalizeRecipeIngredientsForPlanning(rawIngredients, cfg || {});
        const station = stationForRecipe(recipe);
        const variantId = recipeVariantId(rawIngredients);
        const scoreInfo = scoreRecipeVariant(item, rawIngredients, ingredients, ctx);
        return {
          station,
          processType: "craft",
          ingredients: rawIngredients,
          normalizedIngredients: ingredients,
          variantId,
          recipe,
          score: Number(scoreInfo.score || 0)
        };
      })
      .filter((v) => v.ingredients.length > 0);
  }

  variants = variants
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return a.variantId.localeCompare(b.variantId);
    });

  if (!variants.length) {
    return { ok: false, reason: "recipe_unavailable", item };
  }

  const selected = variants[0];
  return {
    ok: true,
    item,
    station: selected.station,
    ingredients: selected.ingredients,
    variants: variants.map((v) => ({
      variantId: v.variantId,
      station: v.station,
      score: v.score,
      ingredients: v.ingredients
    })),
    reply: buildRecipeReply(item, selected, variants)
  };
}

module.exports = {
  isRecipeQuestion,
  resolveRecipeAnswer
};
