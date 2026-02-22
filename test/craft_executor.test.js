const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");

const { executeCraftPlan, inventoryCount, __test } = require("../brain/craft_executor");

function makeLogger() {
  const events = [];
  const log = (e) => events.push(e);
  return { log, events };
}

test("ensure_table places crafting table when missing", async () => {
  let placed = false;
  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: {
      items: () => [{ name: "crafting_table", count: 1 }]
    },
    findBlock: ({ matching }) => {
      if (typeof matching === "number") {
        return placed ? { position: new Vec3(1, 64, 0), name: "crafting_table" } : null;
      }
      if (typeof matching === "function") {
        return { position: new Vec3(0, 63, 0), boundingBox: "block" };
      }
      return null;
    },
    blockAt: (pos) => ({ position: pos, name: "crafting_table" }),
    equip: async () => {},
    placeBlock: async () => { placed = true; },
    waitForTicks: async () => {}
  };
  const { log } = makeLogger();
  const plan = {
    item: "crafting_table",
    count: 1,
    timeoutSec: 10,
    steps: [{ action: "ensure_table" }]
  };
  const result = await executeCraftPlan(
    bot,
    plan,
    { craftAutoPlaceTable: true, reasoningEnabled: false },
    { isCancelled: () => false },
    log
  );
  assert.equal(result.status, "success");
  assert.equal(placed, true);
});

test("cancelled run context returns cancel", async () => {
  const bot = {
    version: "1.21.1",
    inventory: { items: () => [] },
    waitForTicks: async () => {}
  };
  const { log } = makeLogger();
  const plan = { item: "stick", count: 1, timeoutSec: 10, steps: [{ action: "ensure_item", item: "stick", count: 1 }] };
  const result = await executeCraftPlan(bot, plan, {}, { isCancelled: () => true }, log);
  assert.equal(result.status, "cancel");
});

test("past deadline returns timeout", async () => {
  const bot = {
    version: "1.21.1",
    inventory: { items: () => [] },
    waitForTicks: async () => {}
  };
  const { log } = makeLogger();
  const plan = { item: "stick", count: 1, timeoutSec: -1, steps: [{ action: "ensure_item", item: "stick", count: 1 }] };
  const result = await executeCraftPlan(bot, plan, {}, { isCancelled: () => false }, log);
  assert.equal(result.status, "timeout");
});

test("ensure_item planks works without unknown craft item error", async () => {
  const inv = [{ name: "oak_log", count: 1 }];
  const bot = {
    version: "1.21.1",
    inventory: { items: () => inv },
    recipesFor: (_itemId) => [{ id: "planks_recipe" }],
    craft: async () => {
      const existing = inv.find((i) => i.name === "oak_planks");
      if (existing) existing.count += 4;
      else inv.push({ name: "oak_planks", count: 4 });
    },
    waitForTicks: async () => {}
  };
  const { log } = makeLogger();
  const plan = { item: "planks", count: 4, timeoutSec: 10, steps: [{ action: "ensure_item", item: "planks", count: 4 }] };
  const result = await executeCraftPlan(bot, plan, {}, { isCancelled: () => false }, log);
  assert.equal(result.status, "success");
});

test("ensure_table reuses nearby placed crafting table", async () => {
  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    findBlock: ({ matching }) => {
      if (typeof matching === "number") {
        return { position: new Vec3(1, 64, 0), name: "crafting_table", boundingBox: "block" };
      }
      return null;
    },
    placeBlock: async () => {
      throw new Error("should not place when table already nearby");
    },
    waitForTicks: async () => {}
  };
  const { log } = makeLogger();
  const plan = {
    item: "crafting_table",
    count: 0,
    timeoutSec: 10,
    steps: [{ action: "ensure_table" }]
  };
  const result = await executeCraftPlan(
    bot,
    plan,
    { craftAutoPlaceTable: true, reasoningEnabled: false },
    { isCancelled: () => false },
    log
  );
  assert.equal(result.status, "success");
});

test("inventoryCount handles namespaced names and slots fallback", () => {
  const bot = {
    inventory: {
      items: () => [],
      slots: [
        null,
        { name: "minecraft:crafting_table", count: 1 },
        { name: "minecraft:oak_planks", count: 8 },
        { name: "minecraft:oak_log", count: 3 }
      ]
    }
  };

  assert.equal(inventoryCount(bot, "crafting_table"), 1);
  assert.equal(inventoryCount(bot, "planks"), 8);
  assert.equal(inventoryCount(bot, "log"), 3);
});

test("stone_sword uses existing sticks/planks/table and does not request logs", async () => {
  const inv = [
    { name: "minecraft:cobblestone", count: 2 },
    { name: "minecraft:stick", count: 2 },
    { name: "minecraft:oak_planks", count: 4 }
  ];
  let scannedForLogs = 0;

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv },
    findBlock: ({ matching }) => {
      if (typeof matching === "number") {
        return { position: new Vec3(1, 64, 0), name: "crafting_table", boundingBox: "block" };
      }
      if (typeof matching === "function") {
        scannedForLogs += 1;
        return null;
      }
      return null;
    },
    recipesFor: () => [{ id: "stone_sword_recipe" }],
    craft: async () => {
      const existing = inv.find((i) => i.name === "minecraft:stone_sword");
      if (existing) existing.count += 1;
      else inv.push({ name: "minecraft:stone_sword", count: 1 });
    },
    waitForTicks: async () => {}
  };

  const plan = {
    item: "stone_sword",
    count: 1,
    timeoutSec: 10,
    steps: [{ action: "ensure_item", item: "stone_sword", count: 1 }]
  };
  const result = await executeCraftPlan(
    bot,
    plan,
    { craftAutoPlaceTable: true, reasoningEnabled: false },
    { isCancelled: () => false },
    () => {}
  );

  assert.equal(result.status, "success");
  assert.equal(scannedForLogs, 0);
});

test("dynamic move timeout scales with distance and is bounded", () => {
  const near = __test.moveTimeoutForDistance(
    { dynamicMoveTimeoutBaseMs: 12000, dynamicMoveTimeoutPerBlockMs: 180 },
    5
  );
  const far = __test.moveTimeoutForDistance(
    { dynamicMoveTimeoutBaseMs: 12000, dynamicMoveTimeoutPerBlockMs: 180 },
    200
  );
  assert.equal(near > 12000, true);
  assert.equal(far >= near, true);
  assert.equal(far <= 45000, true);
});

test("recipe selector avoids bamboo stick route when not preferred", () => {
  const mcData = require("minecraft-data")("1.21.1");
  const stickId = mcData.itemsByName.stick.id;
  const all = mcData.recipes[stickId] || [];
  const bambooRecipe = all.find((r) => {
    const ings = r.inShape?.flat?.() || r.ingredients || [];
    return ings.some((id) => mcData.items[Number(id)]?.name === "bamboo");
  });
  const planksRecipe = all.find((r) => {
    const ings = r.inShape?.flat?.() || r.ingredients || [];
    return ings.some((id) => String(mcData.items[Number(id)]?.name || "").endsWith("_planks"));
  });
  assert.ok(bambooRecipe);
  assert.ok(planksRecipe);

  const bot = {
    version: "1.21.1",
    inventory: {
      items: () => [
        { name: "bamboo", count: 16 },
        { name: "oak_planks", count: 16 }
      ]
    }
  };

  const selected = __test.selectBestCraftRecipe(
    [bambooRecipe, planksRecipe],
    "stick",
    bot,
    { materialFlexPolicy: "inventory_first_any_wood", preferBambooForSticks: false },
    () => {}
  );
  assert.equal(selected, planksRecipe);
});
