const test = require("node:test");
const assert = require("node:assert/strict");

const { parseNLU } = require("../brain/nlu");

const cfg = { owner: "NoSafeSky", maxExploreRadius: 500, craftDefaultCount: 1 };

test("craft me a wooden sword -> craftItem wooden_sword x1", () => {
  const intent = parseNLU("craft me a wooden sword", cfg, null);
  assert.equal(intent.type, "craftItem");
  assert.equal(intent.item, "wooden_sword");
  assert.equal(intent.count, 1);
});

test("make 2 stone pickaxes -> craftItem stone_pickaxe x2", () => {
  const intent = parseNLU("make 2 stone pickaxes", cfg, null);
  assert.equal(intent.type, "craftItem");
  assert.equal(intent.item, "stone_pickaxe");
  assert.equal(intent.count, 2);
});

test("craft me an iron sword -> craftItem iron_sword x1", () => {
  const intent = parseNLU("craft me an iron sword", cfg, null);
  assert.equal(intent.type, "craftItem");
  assert.equal(intent.item, "iron_sword");
  assert.equal(intent.count, 1);
});

test("craft me a banana sword -> unknown_craft_target", () => {
  const intent = parseNLU("craft me a banana sword", cfg, null);
  assert.equal(intent.type, "none");
  assert.equal(intent.reason, "unknown_craft_target");
});
