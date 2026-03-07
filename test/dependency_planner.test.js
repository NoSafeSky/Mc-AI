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

function stepSignature(plan) {
  return plan.steps.map((s) => `${s.action}:${s.args?.item || s.args?.station || ""}`);
}

test("stone_sword from empty inventory builds dynamic dependency plan", () => {
  const bot = makeBot([]);
  const plan = buildGoalPlan(bot, { type: "craftItem", item: "stone_sword", count: 1 }, {
    dependencyMaxDepth: 10,
    dependencyMaxNodes: 400,
    dependencyPlanTimeoutMs: 3000,
    autoGatherRadius: 48
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.item, "stone_sword");
  assert.equal(plan.steps.some((s) => s.action === "craft_recipe" && s.args?.item === "stone_sword"), true);
  assert.equal(plan.steps.some((s) => ["gather_block", "harvest_crop", "kill_mob_drop", "smelt_recipe"].includes(s.action)), true);
});

test("stone_sword with prerequisites already in inventory avoids gather steps", () => {
  const bot = makeBot([
    { name: "minecraft:cobbled_deepslate", count: 2 },
    { name: "minecraft:cobblestone", count: 2 },
    { name: "minecraft:stick", count: 1 },
    { name: "minecraft:crafting_table", count: 1 },
    { name: "minecraft:oak_planks", count: 8 }
  ]);
  const plan = buildGoalPlan(bot, { type: "craftItem", item: "stone_sword", count: 1 }, {
    dependencyMaxDepth: 10,
    dependencyMaxNodes: 400,
    dependencyPlanTimeoutMs: 3000
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.steps.some((s) => ["gather_block", "harvest_crop", "kill_mob_drop", "smelt_recipe"].includes(s.action)), false);
  assert.equal(plan.steps.some((s) => s.action === "craft_recipe" && s.args?.item === "stone_sword"), true);
});

test("planner is deterministic for same world snapshot", () => {
  const botA = makeBot([]);
  const botB = makeBot([]);
  const cfg = {
    dependencyMaxDepth: 10,
    dependencyMaxNodes: 400,
    dependencyPlanTimeoutMs: 3000
  };
  const planA = buildGoalPlan(botA, { type: "craftItem", item: "stone_sword", count: 1 }, cfg);
  const planB = buildGoalPlan(botB, { type: "craftItem", item: "stone_sword", count: 1 }, cfg);

  assert.equal(planA.ok, true);
  assert.equal(planB.ok, true);
  assert.deepEqual(stepSignature(planA), stepSignature(planB));
});

test("wooden_sword with oak_planks in inventory avoids log gather", () => {
  const bot = makeBot([
    { name: "minecraft:oak_planks", count: 4 },
    { name: "minecraft:stick", count: 2 },
    { name: "minecraft:crafting_table", count: 1 }
  ]);
  const plan = buildGoalPlan(bot, { type: "craftItem", item: "wooden_sword", count: 1 }, {
    dependencyMaxDepth: 10,
    dependencyMaxNodes: 400,
    dependencyPlanTimeoutMs: 3000,
    materialFlexPolicy: "inventory_first_any_wood"
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.steps.some((s) => s.action === "gather_block" && s.args?.item === "log"), false);
  assert.equal(plan.steps.some((s) => s.action === "craft_recipe" && s.args?.item === "wooden_sword"), true);
});

test("wooden_sword with cached station planks avoids log gather", () => {
  const bot = makeBot([
    { name: "minecraft:stick", count: 2 }
  ]);
  bot.__stationInventoryCache = {
    counts: {
      oak_planks: 8
    },
    sources: []
  };

  const plan = buildGoalPlan(bot, { type: "craftItem", item: "wooden_sword", count: 1 }, {
    dependencyMaxDepth: 10,
    dependencyMaxNodes: 400,
    dependencyPlanTimeoutMs: 3000,
    materialFlexPolicy: "inventory_first_any_wood"
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.steps.some((s) => s.action === "gather_block" && s.args?.item === "log"), false);
  assert.equal(plan.steps.some((s) => s.action === "craft_recipe" && s.args?.item === "wooden_sword"), true);
});

test("wooden_sword with birch_log plans via log -> planks family", () => {
  const bot = makeBot([{ name: "minecraft:birch_log", count: 1 }]);
  const plan = buildGoalPlan(bot, { type: "craftItem", item: "wooden_sword", count: 1 }, {
    dependencyMaxDepth: 10,
    dependencyMaxNodes: 400,
    dependencyPlanTimeoutMs: 3000,
    materialFlexPolicy: "inventory_first_any_wood"
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.needs.some((n) => n.item === "planks"), true);
  assert.equal(plan.steps.some((s) => s.action === "gather_block" && s.args?.item === "acacia_log"), false);
});

test("iron_pickaxe plan includes stone gate, raw iron gather, smelt, and final craft", () => {
  const bot = makeBot([]);
  const events = [];
  const plan = buildGoalPlan(
    bot,
    { type: "craftItem", item: "iron_pickaxe", count: 1 },
    {
      dependencyMaxDepth: 12,
      dependencyMaxNodes: 2000,
      dependencyPlanTimeoutMs: 8000,
      craftCoverageMode: "overworld_v1",
      craftRecipeManifestVersion: "1.21.1-overworld-v1",
      preferBambooForSticks: false
    },
    null,
    (evt) => events.push(evt)
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.steps.some((s) => s.action === "craft_recipe" && s.args?.item === "wooden_pickaxe"), true);
  assert.equal(plan.steps.some((s) => s.action === "craft_recipe" && s.args?.item === "stone_pickaxe"), true);
  assert.equal(plan.steps.some((s) => s.action === "craft_recipe" && s.args?.item === "furnace"), true);
  assert.equal(plan.steps.some((s) => s.action === "ensure_station" && s.args?.station === "furnace"), true);
  assert.equal(plan.steps.some((s) => s.action === "gather_block" && s.args?.item === "raw_iron"), true);
  assert.equal(plan.steps.some((s) => s.action === "smelt_recipe" && s.args?.item === "iron_ingot"), true);
  assert.equal(plan.steps.some((s) => s.action === "craft_recipe" && s.args?.item === "iron_pickaxe"), true);
  assert.equal(events.some((e) => e.type === "progression_gate"), true);
});

test("overworld mode rejects out-of-scope target with unsupported_scope", () => {
  const bot = makeBot([]);
  const plan = buildGoalPlan(bot, { type: "craftItem", item: "netherite_sword", count: 1 }, {
    dependencyMaxDepth: 10,
    dependencyMaxNodes: 400,
    dependencyPlanTimeoutMs: 3000,
    craftCoverageMode: "overworld_v1",
    craftRecipeManifestVersion: "1.21.1-overworld-v1"
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.code, "unsupported_scope");
});

test("depth and node limits fail safely", () => {
  const bot = makeBot([]);
  const depthFail = buildGoalPlan(bot, { type: "craftItem", item: "stone_sword", count: 1 }, {
    dependencyMaxDepth: 0,
    dependencyMaxNodes: 400,
    dependencyPlanTimeoutMs: 3000
  });
  assert.equal(depthFail.ok, false);
  assert.equal(depthFail.code, "dependency_depth_limit");

  const nodeFail = buildGoalPlan(bot, { type: "craftItem", item: "stone_sword", count: 1 }, {
    dependencyMaxDepth: 10,
    dependencyMaxNodes: 1,
    dependencyPlanTimeoutMs: 3000
  });
  assert.equal(nodeFail.ok, false);
  assert.equal(nodeFail.code, "dependency_node_limit");
});
