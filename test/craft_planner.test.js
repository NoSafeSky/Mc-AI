const test = require("node:test");
const assert = require("node:assert/strict");

const { buildCraftPlan } = require("../brain/craft_planner");

const bot = { version: "1.21.1" };

test("wooden_sword plan builds deterministic steps", () => {
  const plan = buildCraftPlan(bot, "wooden_sword", 1, { craftJobTimeoutSec: 90 });
  assert.equal(plan.ok, true);
  assert.equal(plan.item, "wooden_sword");
  assert.equal(plan.steps.some((s) => s.action === "ensure_table"), true);
  assert.equal(plan.steps.some((s) => s.action === "craft" && s.item === "wooden_sword"), true);
});

test("stone_sword plan includes cobble acquisition and no smelting", () => {
  const plan = buildCraftPlan(bot, "stone_sword", 1, { craftJobTimeoutSec: 90 });
  assert.equal(plan.ok, true);
  assert.equal(plan.steps.some((s) => s.action === "mine_cobble"), true);
  assert.equal(plan.steps.some((s) => s.action === "acquire_pickaxe"), true);
  assert.equal(plan.steps.some((s) => s.action === "smelt" || s.action === "furnace"), false);
});
