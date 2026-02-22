const test = require("node:test");
const assert = require("node:assert/strict");

const { isRecipeQuestion, resolveRecipeAnswer } = require("../brain/recipe_qa");

test("how to craft a mace returns deterministic mc-data recipe", () => {
  assert.equal(isRecipeQuestion("how to craft a mace"), true);
  const answer = resolveRecipeAnswer("how to craft a mace", "1.21.1");
  assert.equal(answer.ok, true);
  assert.equal(answer.item, "mace");
  const ingredientNames = answer.ingredients.map((i) => i.name);
  assert.equal(ingredientNames.includes("heavy_core"), true);
  assert.equal(ingredientNames.includes("breeze_rod"), true);
});

test("unknown recipe target returns explicit unknown result", () => {
  const answer = resolveRecipeAnswer("how to craft banana sword", "1.21.1");
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, "recipe_item_unknown");
});

test("explicit craft command text is not treated as recipe question", () => {
  assert.equal(isRecipeQuestion("craft me a stone sword"), false);
});
