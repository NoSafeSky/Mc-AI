const test = require("node:test");
const assert = require("node:assert/strict");

const {
  fuelPlan,
  findFuelInventoryItem,
  isFuelItemName,
  requiredFuelItemCount
} = require("../brain/fuel_planner");

test("fuel planner prefers inventory-first policy list", () => {
  const plan = fuelPlan({ fuelPolicy: "inventory_first_then_charcoal_then_coal" }, 3);
  assert.equal(plan.requiredFuelUnits, 3);
  assert.equal(Array.isArray(plan.preferred), true);
  assert.equal(plan.preferred.includes("charcoal"), true);
});

test("findFuelInventoryItem selects best fuel from inventory", () => {
  const bot = {
    inventory: {
      items: () => [
        { name: "stick", count: 16 },
        { name: "coal", count: 2 }
      ]
    }
  };
  const found = findFuelInventoryItem(bot, ["coal", "charcoal", "stick"]);
  assert.ok(found);
  assert.equal(found.name, "coal");
});

test("findFuelInventoryItem with minSmelts skips underpowered stack", () => {
  const bot = {
    inventory: {
      items: () => [
        { name: "stick", count: 1 },
        { name: "oak_planks", count: 1 }
      ]
    }
  };
  const found = findFuelInventoryItem(bot, ["stick", "oak_planks"], { minSmelts: 1 });
  assert.ok(found);
  assert.equal(found.name, "oak_planks");
});

test("isFuelItemName recognizes normalized fuel names", () => {
  assert.equal(isFuelItemName("minecraft:coal"), true);
  assert.equal(isFuelItemName("oak_log"), true);
  assert.equal(isFuelItemName("stone"), false);
});

test("requiredFuelItemCount accounts for weak fuels", () => {
  assert.equal(requiredFuelItemCount("stick", 1), 2);
  assert.equal(requiredFuelItemCount("coal", 9), 2);
});
