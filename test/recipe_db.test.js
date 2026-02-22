const test = require("node:test");
const assert = require("node:assert/strict");

const { buildRecipeDb, getRecipeVariants, getStationForVariant } = require("../brain/recipe_db");

test("recipe_db loads deterministic variants for known items", () => {
  const db = buildRecipeDb("1.21.1");
  assert.ok(db.entriesByOutput.size > 0);
  const variants = getRecipeVariants("stone_sword", { version: "1.21.1" });
  assert.ok(variants.length > 0);
  assert.equal(variants.every((v) => Array.isArray(v.ingredients) && v.ingredients.length > 0), true);
});

test("recipe_db includes smelt station recipes", () => {
  const variants = getRecipeVariants("glass", { version: "1.21.1" });
  const smelt = variants.find((v) => v.processType === "smelt");
  assert.ok(smelt);
  assert.equal(smelt.station, "furnace");
});

test("getStationForVariant resolves stored station", () => {
  const variants = getRecipeVariants("stone_sword", { version: "1.21.1" });
  const variant = variants[0];
  assert.ok(variant);
  const station = getStationForVariant(variant.variantId, { version: "1.21.1" });
  assert.equal(typeof station, "string");
  assert.equal(station.length > 0, true);
});
