const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");

const { buildGoalPlan } = require("../brain/dependency_planner");

function makeBot(items = []) {
  return {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => items },
    entities: {},
    findBlock: () => null
  };
}

test("planner builds medium chain with budget stats", () => {
  const bot = makeBot([]);
  const events = [];
  const plan = buildGoalPlan(
    bot,
    { type: "craftItem", item: "stone_sword", count: 1 },
    {
      dependencyMaxDepth: 10,
      dependencyMaxNodes: 1200,
      dependencyPlanTimeoutMs: 8000,
      recipePlannerBeamWidth: 24,
      recipeVariantCapPerItem: 32
    },
    null,
    (evt) => events.push(evt)
  );

  assert.equal(plan.ok, true);
  assert.ok(plan.budgetStats);
  assert.equal(typeof plan.budgetStats.elapsedMs, "number");
  assert.equal(events.some((e) => e.type === "planner_budget_start"), true);
});

test("planner emits budget exhausted logs on tiny budget", () => {
  const bot = makeBot([]);
  const events = [];
  const plan = buildGoalPlan(
    bot,
    { type: "craftItem", item: "stone_sword", count: 1 },
    {
      dependencyMaxDepth: 10,
      dependencyMaxNodes: 1,
      dependencyPlanTimeoutMs: 50,
      recipePlannerBeamWidth: 2,
      recipeVariantCapPerItem: 2
    },
    null,
    (evt) => events.push(evt)
  );

  assert.equal(plan.ok, false);
  assert.equal(events.some((e) => e.type === "planner_budget_exhausted"), true);
});
