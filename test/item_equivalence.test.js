const test = require("node:test");
const assert = require("node:assert/strict");

const {
  itemFamily,
  normalizePlanningItem,
  equivalentInventoryCount,
  equivalentInventoryConsume,
  isWoodEquivalent
} = require("../brain/item_equivalence");

const cfg = { materialFlexPolicy: "inventory_first_any_wood" };

test("item family detection handles logs and planks", () => {
  assert.equal(itemFamily("oak_log"), "log");
  assert.equal(itemFamily("warped_stem"), "log");
  assert.equal(itemFamily("spruce_planks"), "planks");
  assert.equal(itemFamily("stone"), null);
  assert.equal(isWoodEquivalent("cherry_log"), true);
});

test("normalize planning item maps wood variants to families", () => {
  assert.equal(normalizePlanningItem("oak_planks", cfg), "planks");
  assert.equal(normalizePlanningItem("mangrove_log", cfg), "log");
  assert.equal(normalizePlanningItem("stick", cfg), "stick");
});

test("equivalent inventory count treats species as interchangeable", () => {
  const inv = {
    oak_planks: 3,
    spruce_planks: 2,
    birch_log: 1
  };
  assert.equal(equivalentInventoryCount(inv, "planks", cfg), 5);
  assert.equal(equivalentInventoryCount(inv, "oak_planks", cfg), 5);
  assert.equal(equivalentInventoryCount(inv, "log", cfg), 1);
});

test("equivalent consume is deterministic exact-first then family", () => {
  const inv = {
    oak_planks: 2,
    spruce_planks: 3
  };
  const res = equivalentInventoryConsume(inv, "oak_planks", 4, cfg);
  assert.equal(res.remainder, 0);
  assert.deepEqual(res.consumed, [
    { item: "oak_planks", count: 2 },
    { item: "spruce_planks", count: 2 }
  ]);
});
