const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");

const { executeCraftPlan, executeGoalPlan, inventoryCount, __test } = require("../brain/craft_executor");

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

test("craft_recipe preflight ignores slot ghosts and backfills missing ingredients", async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const oakPlanksId = mcData.itemsByName.oak_planks.id;
  const craftingTableId = mcData.itemsByName.crafting_table.id;
  const inv = [{ name: "oak_log", count: 1 }];
  const ghostSlots = [{ name: "oak_planks", count: 64 }];
  const { log, events } = makeLogger();

  function count(name) {
    return inv
      .filter((row) => row.name === name)
      .reduce((sum, row) => sum + Number(row.count || 0), 0);
  }

  function add(name, n) {
    const row = inv.find((it) => it.name === name);
    if (row) row.count += n;
    else inv.push({ name, count: n });
  }

  function consume(name, n) {
    let left = n;
    for (const row of inv) {
      if (row.name !== name || left <= 0) continue;
      const take = Math.min(row.count, left);
      row.count -= take;
      left -= take;
    }
    for (let i = inv.length - 1; i >= 0; i -= 1) {
      if (inv[i].count <= 0) inv.splice(i, 1);
    }
  }

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: {
      items: () => inv,
      slots: ghostSlots
    },
    recipesFor: (itemId) => {
      if (itemId === oakPlanksId) return count("oak_log") >= 1 ? [{ id: "recipe_planks" }] : [];
      if (itemId === craftingTableId) return count("oak_planks") >= 4 ? [{ id: "recipe_table" }] : [];
      return [];
    },
    craft: async (recipe) => {
      if (recipe.id === "recipe_planks") {
        consume("oak_log", 1);
        add("oak_planks", 4);
        return;
      }
      if (recipe.id === "recipe_table") {
        consume("oak_planks", 4);
        add("crafting_table", 1);
      }
    },
    waitForTicks: async () => {}
  };

  const plan = {
    ok: true,
    goalId: "goal_slot_ghosts",
    item: "crafting_table",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_slot_ghosts_s1",
        action: "craft_recipe",
        args: {
          item: "crafting_table",
          count: 1,
          station: "inventory",
          processType: "craft",
          outputItem: "crafting_table",
          ingredients: [{ name: "planks", count: 4 }]
        },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    plan,
    { reasoningEnabled: false, materialFlexPolicy: "inventory_first_any_wood" },
    { id: 992, isCancelled: () => false, setStep() {}, reportProgress() {} },
    log
  );

  assert.equal(result.status, "success");
  assert.equal(inventoryCount(bot, "crafting_table"), 1);
  assert.equal(events.some((e) => e.type === "craft_recipe_missing_ingredients"), true);
});

test("craft_recipe retries transient empty recipe probe and succeeds", async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const craftingTableId = mcData.itemsByName.crafting_table.id;
  const inv = [{ name: "oak_planks", count: 4 }];
  const { log, events } = makeLogger();
  let craftingTableProbeCount = 0;

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv },
    recipesFor: (itemId) => {
      if (itemId !== craftingTableId) return [];
      craftingTableProbeCount += 1;
      if (craftingTableProbeCount === 1) return [];
      return [{ id: "recipe_table_retry" }];
    },
    craft: async () => {
      inv.length = 0;
      inv.push({ name: "crafting_table", count: 1 });
    },
    waitForTicks: async () => {}
  };

  const plan = {
    ok: true,
    goalId: "goal_retry_probe",
    item: "crafting_table",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_retry_probe_s1",
        action: "craft_recipe",
        args: {
          item: "crafting_table",
          count: 1,
          station: "inventory",
          processType: "craft",
          outputItem: "crafting_table",
          ingredients: [{ name: "planks", count: 4 }]
        },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    plan,
    { reasoningEnabled: false },
    { id: 993, isCancelled: () => false, setStep() {}, reportProgress() {} },
    log
  );

  assert.equal(result.status, "success");
  assert.equal(inventoryCount(bot, "crafting_table"), 1);
  assert.equal(events.some((e) => e.type === "craft_recipe_retry"), true);
  assert.equal(events.filter((e) => e.type === "craft_recipe_probe").length >= 2, true);
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

test("craft_recipe moves near crafting table so stone_pickaxe recipe resolves", async () => {
  const inv = [
    { name: "cobblestone", count: 3, type: 1 },
    { name: "stick", count: 2, type: 2 }
  ];
  const tablePos = new Vec3(10, 64, 0);

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv },
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      },
      setMovements() {}
    },
    findBlock: ({ matching }) => {
      if (typeof matching === "number") {
        return { position: tablePos, name: "crafting_table", boundingBox: "block" };
      }
      return null;
    },
    blockAt: (pos) => {
      if (!pos) return null;
      if (pos.x === tablePos.x && pos.y === tablePos.y && pos.z === tablePos.z) {
        return { position: tablePos, name: "crafting_table", boundingBox: "block" };
      }
      return { position: pos, name: "air", boundingBox: "empty" };
    },
    recipesFor: (_id, _meta, _count, table) => {
      if (!table || !table.position) return [];
      const dist = bot.entity.position.distanceTo(table.position);
      if (dist > 4.5) return [];
      return [{ id: "stone_pickaxe_recipe" }];
    },
    craft: async () => {
      inv.push({ name: "stone_pickaxe", count: 1, type: 3 });
    },
    waitForTicks: async () => {}
  };

  const plan = {
    ok: true,
    goalId: "goal_table_range",
    item: "stone_pickaxe",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_table_range_s1",
        action: "ensure_station",
        args: { station: "crafting_table" },
        retryPolicy: {},
        timeoutMs: 1000
      },
      {
        id: "goal_table_range_s2",
        action: "craft_recipe",
        args: {
          item: "stone_pickaxe",
          count: 1,
          station: "crafting_table",
          processType: "craft"
        },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    plan,
    { reasoningEnabled: false, movementProfile: "human_cautious" },
    { id: 991, isCancelled: () => false, setStep() {}, reportProgress() {} },
    () => {}
  );

  assert.equal(result.status, "success");
  assert.equal(inventoryCount(bot, "stone_pickaxe"), 1);
});

test("ensure_station furnace auto-acquires missing furnace item and continues", async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const furnaceId = mcData.itemsByName.furnace.id;
  const tableId = mcData.blocksByName.crafting_table.id;
  const furnaceBlockId = mcData.blocksByName.furnace.id;
  const tablePos = new Vec3(1, 64, 0);
  const inv = [{ name: "cobblestone", count: 8 }];
  let placedFurnacePos = null;
  const events = [];

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    heldItem: null,
    entities: {},
    inventory: { items: () => inv },
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      },
      setMovements() {}
    },
    findBlock: ({ matching }) => {
      if (typeof matching !== "number") return null;
      if (matching === tableId) return { position: tablePos, name: "crafting_table", boundingBox: "block" };
      if (matching === furnaceBlockId && placedFurnacePos) {
        return { position: placedFurnacePos, name: "furnace", boundingBox: "block" };
      }
      return null;
    },
    blockAt: (pos) => {
      if (!pos) return null;
      if (pos.x === tablePos.x && pos.y === tablePos.y && pos.z === tablePos.z) {
        return { position: tablePos, name: "crafting_table", boundingBox: "block" };
      }
      if (placedFurnacePos && pos.x === placedFurnacePos.x && pos.y === placedFurnacePos.y && pos.z === placedFurnacePos.z) {
        return { position: placedFurnacePos, name: "furnace", boundingBox: "block" };
      }
      if (pos.y === 63) return { position: pos, name: "stone", boundingBox: "block" };
      return { position: pos, name: "air", boundingBox: "empty" };
    },
    equip: async (item) => {
      bot.heldItem = item;
    },
    recipesFor: (itemId, _meta, _count, table) => {
      if (itemId !== furnaceId) return [];
      if (!table || !table.position) return [];
      const haveCobble = inv.reduce((sum, row) => sum + (row.name === "cobblestone" ? Number(row.count || 0) : 0), 0);
      return haveCobble >= 8 ? [{ id: "recipe_furnace" }] : [];
    },
    craft: async () => {
      const cobble = inv.find((r) => r.name === "cobblestone");
      if (cobble) cobble.count = Math.max(0, Number(cobble.count || 0) - 8);
      inv.push({ name: "furnace", count: 1 });
    },
    placeBlock: async (reference, face) => {
      placedFurnacePos = reference.position.offset(face.x, face.y, face.z);
      const row = inv.find((r) => r.name === "furnace");
      if (row) row.count = Math.max(0, Number(row.count || 0) - 1);
    },
    waitForTicks: async () => {}
  };

  const plan = {
    ok: true,
    goalId: "goal_station_auto_furnace",
    item: "furnace",
    count: 0,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_station_auto_furnace_s1",
        action: "ensure_station",
        args: { station: "furnace" },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    plan,
    { reasoningEnabled: false, craftAutoPlaceTable: true },
    { id: 995, isCancelled: () => false, setStep() {}, reportProgress() {} },
    (evt) => events.push(evt)
  );

  assert.equal(result.status, "success");
  assert.ok(placedFurnacePos);
  assert.equal(events.some((e) => e.type === "station_auto_acquire" && e.station === "furnace"), true);
});

test("gather confirms drop pickup when item entity disappears", async () => {
  const events = [];
  const inv = [];
  const targetPos = new Vec3(1, 64, 0);
  const dropId = 301;
  let blockBroken = false;
  let waitedTicks = 0;

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    entities: {},
    inventory: { items: () => inv },
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      },
      setMovements() {}
    },
    findBlocks: ({ matching }) => {
      const sample = { name: "stone", position: targetPos };
      return matching(sample) ? [targetPos] : [];
    },
    blockAt: (pos) => {
      if (!pos) return null;
      if (pos.y === 63) return { position: pos, name: "stone", boundingBox: "block" };
      if (pos.x === targetPos.x && pos.y === targetPos.y && pos.z === targetPos.z) {
        if (blockBroken) return { position: pos, name: "air", boundingBox: "empty" };
        return { position: pos, name: "stone", boundingBox: "block" };
      }
      return { position: pos, name: "air", boundingBox: "empty" };
    },
    dig: async () => {
      blockBroken = true;
      bot.entities[dropId] = {
        id: dropId,
        name: "item",
        type: "object",
        position: new Vec3(1, 64, 0)
      };
    },
    waitForTicks: async (ticks) => {
      waitedTicks += Number(ticks || 0);
      if (waitedTicks >= 20 && bot.entities[dropId]) {
        delete bot.entities[dropId];
        const row = inv.find((r) => r.name === "cobblestone");
        if (row) row.count += 1;
        else inv.push({ name: "cobblestone", count: 1 });
      }
    }
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_drop_confirm",
    item: "cobblestone",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_drop_confirm_s1",
        action: "gather_block",
        args: { item: "cobblestone", count: 1, blockNames: ["stone"], preferredBlocks: ["stone"] },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      gatherRadiusSteps: [24],
      gatherExpandRetryPerRing: 1,
      gatherDropRecoveryRetries: 2,
      strictHarvestToolGate: false,
      reasoningEnabled: false
    },
    { id: 994, isCancelled: () => false, setStep() {}, reportProgress() {} },
    (evt) => events.push(evt)
  );

  assert.equal(result.status, "success");
  assert.equal(events.some((e) => e.type === "gather_drop_scan"), true);
  assert.equal(events.some((e) => e.type === "gather_pickup_retry"), true);
  assert.equal(
    events.some((e) => e.type === "gather_dig_result" && (e.result === "ok_after_drop_confirm" || e.result === "ok_after_close_pickup")),
    true
  );
});
