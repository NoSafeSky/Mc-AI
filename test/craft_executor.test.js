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

test("craft_recipe withdraws missing ingredient from cached nearby station inventory", async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const craftingTableId = mcData.itemsByName.crafting_table.id;
  const oakPlanksId = mcData.itemsByName.oak_planks.id;
  const inv = [];
  const chestPos = new Vec3(1, 64, 0);
  let chestPlanks = 4;

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv },
    __stationInventoryCache: {
      counts: { oak_planks: 4 },
      sources: [{
        stationType: "chest",
        position: chestPos,
        slot: "container",
        itemName: "oak_planks",
        count: 4,
        itemType: oakPlanksId,
        metadata: null
      }]
    },
    blockAt(pos) {
      return { position: pos, name: "chest", boundingBox: "block" };
    },
    openChest: async () => ({
      withdraw: async (_type, _meta, count) => {
        const moved = Math.min(chestPlanks, count);
        chestPlanks -= moved;
        inv.push({ name: "oak_planks", count: moved, type: oakPlanksId, metadata: null });
      },
      close() {}
    }),
    recipesFor: (itemId) => {
      if (itemId !== craftingTableId) return [];
      const planks = inv
        .filter((row) => row.name === "oak_planks")
        .reduce((sum, row) => sum + Number(row.count || 0), 0);
      return planks >= 4 ? [{ id: "recipe_table_from_chest" }] : [];
    },
    craft: async () => {
      inv.length = 0;
      inv.push({ name: "crafting_table", count: 1, type: craftingTableId, metadata: null });
    },
    waitForTicks: async () => {}
  };

  const plan = {
    ok: true,
    goalId: "goal_station_pull",
    item: "crafting_table",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_station_pull_s1",
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
    { id: 994, isCancelled: () => false, setStep() {}, reportProgress() {} },
    () => {}
  );

  assert.equal(result.status, "success");
  assert.equal(inventoryCount(bot, "crafting_table"), 1);
  assert.equal(chestPlanks, 0);
});

test("executeGoalPlan pulls final goal output from furnace cache before terminal check", async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const ironIngotId = mcData.itemsByName.iron_ingot.id;
  const furnacePos = new Vec3(1, 64, 0);
  const inv = [];
  let furnaceOutput = 1;

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv },
    __stationInventoryCache: {
      refreshedAt: Date.now(),
      counts: { iron_ingot: 1 },
      sources: [{
        stationType: "furnace",
        position: furnacePos,
        slot: "output",
        itemName: "iron_ingot",
        count: 1,
        itemType: ironIngotId,
        metadata: null
      }]
    },
    blockAt(pos) {
      return { position: pos, name: "furnace", boundingBox: "block" };
    },
    openFurnace: async () => ({
      outputItem: () => (furnaceOutput > 0 ? { type: ironIngotId, name: "iron_ingot", count: furnaceOutput } : null),
      inputItem: () => null,
      fuelItem: () => null,
      takeOutput: async () => {
        if (furnaceOutput <= 0) throw new Error("no output");
        furnaceOutput -= 1;
        inv.push({ name: "iron_ingot", type: ironIngotId, count: 1, metadata: null });
      },
      close() {}
    }),
    waitForTicks: async () => {}
  };

  const result = await executeGoalPlan(
    bot,
    {
      ok: true,
      goalId: "goal_furnace_cached_output",
      item: "iron_ingot",
      count: 1,
      steps: [],
      constraints: { timeoutSec: 20 }
    },
    { reasoningEnabled: false },
    { id: 995, isCancelled: () => false, setStep() {}, reportProgress() {} },
    () => {}
  );

  assert.equal(result.status, "success");
  assert.equal(inventoryCount(bot, "iron_ingot"), 1);
  assert.equal(furnaceOutput, 0);
});

test("executeGoalPlan waits for delayed furnace output inventory sync before terminal check", async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const ironIngotId = mcData.itemsByName.iron_ingot.id;
  const inv = [];
  let furnaceOutput = 1;
  let pendingInventoryTicks = 0;

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv },
    __stationInventoryCache: {
      refreshedAt: Date.now(),
      counts: { iron_ingot: 1 },
      sources: [{
        stationType: "furnace",
        position: { x: 1, y: 64, z: 0 },
        slot: "output",
        itemName: "iron_ingot",
        count: 1,
        itemType: ironIngotId,
        metadata: null
      }]
    },
    blockAt(pos) {
      return { position: pos, name: "furnace", boundingBox: "block" };
    },
    openFurnace: async () => ({
      outputItem: () => (furnaceOutput > 0 ? { type: ironIngotId, name: "iron_ingot", count: furnaceOutput } : null),
      inputItem: () => null,
      fuelItem: () => null,
      takeOutput: async () => {
        if (furnaceOutput <= 0) throw new Error("no output");
        furnaceOutput -= 1;
        pendingInventoryTicks = 6;
      },
      close() {}
    }),
    waitForTicks: async (ticks = 1) => {
      const n = Math.max(1, Number(ticks || 1));
      for (let i = 0; i < n; i += 1) {
        if (pendingInventoryTicks > 0) {
          pendingInventoryTicks -= 1;
          if (pendingInventoryTicks === 0) {
            inv.push({ name: "iron_ingot", type: ironIngotId, count: 1, metadata: null });
          }
        }
      }
    }
  };

  const result = await executeGoalPlan(
    bot,
    {
      ok: true,
      goalId: "goal_furnace_cached_output_delayed_sync",
      item: "iron_ingot",
      count: 1,
      steps: [],
      constraints: { timeoutSec: 20 }
    },
    { reasoningEnabled: false },
    { id: 9951, isCancelled: () => false, setStep() {}, reportProgress() {} },
    () => {}
  );

  assert.equal(result.status, "success");
  assert.equal(inventoryCount(bot, "iron_ingot"), 1);
  assert.equal(furnaceOutput, 0);
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

test("ensure_station furnace withdraws cached nearby furnace item before crafting fallback", async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const furnaceId = mcData.itemsByName.furnace.id;
  const furnaceBlockId = mcData.blocksByName.furnace.id;
  const chestPos = new Vec3(1, 64, 0);
  const inv = [];
  let storedFurnaces = 1;
  let placedFurnacePos = null;
  const events = [];

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    heldItem: null,
    entities: {},
    inventory: { items: () => inv.filter((row) => Number(row.count || 0) > 0) },
    __stationInventoryCache: {
      refreshedAt: Date.now(),
      counts: { furnace: 1 },
      sources: [{
        stationType: "chest",
        position: chestPos,
        slot: "container",
        itemName: "furnace",
        count: 1,
        itemType: furnaceId,
        metadata: null
      }]
    },
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      },
      setMovements() {}
    },
    findBlock: ({ matching }) => {
      if (matching === furnaceBlockId && placedFurnacePos) {
        return { position: placedFurnacePos, name: "furnace", boundingBox: "block" };
      }
      return null;
    },
    blockAt: (pos) => {
      if (!pos) return null;
      if (pos.x === chestPos.x && pos.y === chestPos.y && pos.z === chestPos.z) {
        return { position: chestPos, name: "chest", boundingBox: "block" };
      }
      if (placedFurnacePos && pos.x === placedFurnacePos.x && pos.y === placedFurnacePos.y && pos.z === placedFurnacePos.z) {
        return { position: placedFurnacePos, name: "furnace", boundingBox: "block" };
      }
      if (pos.y === 63) return { position: pos, name: "stone", boundingBox: "block" };
      return { position: pos, name: "air", boundingBox: "empty" };
    },
    openChest: async () => ({
      withdraw: async (_type, _meta, count) => {
        const moved = Math.min(storedFurnaces, Number(count || 0));
        storedFurnaces -= moved;
        if (moved > 0) inv.push({ name: "furnace", count: moved, type: furnaceId, metadata: null });
      },
      close() {}
    }),
    equip: async (item) => {
      bot.heldItem = item;
    },
    craft: async () => {
      throw new Error("should not craft furnace when cached station item exists");
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
    goalId: "goal_station_cached_furnace",
    item: "furnace",
    count: 0,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_station_cached_furnace_s1",
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
    { id: 996, isCancelled: () => false, setStep() {}, reportProgress() {} },
    (evt) => events.push(evt)
  );

  assert.equal(result.status, "success");
  assert.ok(placedFurnacePos);
  assert.equal(storedFurnaces, 0);
  assert.equal(events.some((e) => e.type === "station_inventory_withdraw" && e.item === "furnace"), true);
  assert.equal(events.some((e) => e.type === "station_auto_acquire" && e.station === "furnace"), false);
});

test("ensure_station reuses existing furnace within 32 blocks and does not craft a new one", async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const furnaceBlockId = mcData.blocksByName.furnace.id;
  const furnacePos = new Vec3(20, 64, 0);
  let placeCalled = false;
  let craftCalled = false;

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      },
      setMovements() {}
    },
    findBlock: ({ matching, maxDistance }) => {
      if (matching !== furnaceBlockId) return null;
      if (Number(maxDistance || 0) < 20) return null;
      return { position: furnacePos, name: "furnace", boundingBox: "block" };
    },
    placeBlock: async () => { placeCalled = true; },
    craft: async () => { craftCalled = true; },
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_station_reuse_radius",
    item: "furnace",
    count: 0,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_station_reuse_radius_s1",
        action: "ensure_station",
        args: { station: "furnace" },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    { reasoningEnabled: false, stationSearchRadius: 32 },
    { id: 996, isCancelled: () => false, setStep() {}, reportProgress() {} },
    () => {}
  );

  assert.equal(result.status, "success");
  assert.equal(placeCalled, false);
  assert.equal(craftCalled, false);
  assert.equal(bot.entity.position.distanceTo(furnacePos) <= 2.5, true);
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

test("gather_block abandons stuck dig attempts instead of hanging", async () => {
  const events = [];
  const targetPos = new Vec3(1, 64, 0);

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      },
      setMovements() {}
    },
    findBlocks: ({ matching }) => {
      const sample = { name: "oak_log", position: targetPos };
      return matching(sample) ? [targetPos] : [];
    },
    blockAt: (pos) => {
      if (!pos) return null;
      if (pos.y === 63) return { position: pos, name: "dirt", boundingBox: "block" };
      if (pos.x === targetPos.x && pos.y === targetPos.y && pos.z === targetPos.z) {
        return { position: pos, name: "oak_log", boundingBox: "block" };
      }
      return { position: pos, name: "air", boundingBox: "empty" };
    },
    canDigBlock: () => true,
    dig: async () => new Promise(() => {}),
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_gather_stuck_dig",
    item: "log",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_gather_stuck_dig_s1",
        action: "gather_block",
        args: { item: "log", count: 1, blockNames: ["oak_log"], preferredBlocks: ["oak_log"] },
        retryPolicy: {},
        timeoutMs: 3000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      gatherRadiusSteps: [16],
      gatherExpandRetryPerRing: 1,
      gatherDigTimeoutMs: 50,
      strictHarvestToolGate: false,
      reasoningEnabled: false
    },
    { id: 999, isCancelled: () => false, setStep() {}, reportProgress() {} },
    (evt) => events.push(evt)
  );

  assert.equal(result.status, "fail");
  assert.equal(result.code, "path_blocked");
  assert.equal(events.some((e) => e.type === "gather_dig_error" && String(e.error || "").includes("dig_timeout")), true);
});

test("smelt_recipe collects existing furnace output before requesting more input", async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const furnaceBlockId = mcData.blocksByName.furnace.id;
  const ironIngotId = mcData.itemsByName.iron_ingot.id;
  const inv = [{ name: "raw_iron", count: 1 }];
  let putInputCalls = 0;
  let takeOutputCalls = 0;
  let outputCount = 1;

  const furnace = {
    outputItem: () => (outputCount > 0 ? { type: ironIngotId, name: "iron_ingot", count: outputCount } : null),
    inputItem: () => null,
    fuelItem: () => null,
    putFuel: async () => {},
    putInput: async () => { putInputCalls += 1; },
    takeOutput: async () => {
      takeOutputCalls += 1;
      outputCount = 0;
      inv.push({ name: "iron_ingot", count: 1 });
    },
    close: () => {}
  };

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv },
    findBlock: ({ matching }) => (matching === furnaceBlockId ? { position: new Vec3(1, 64, 0), name: "furnace", boundingBox: "block" } : null),
    openFurnace: async () => furnace,
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_smelt_claim_output",
    item: "iron_ingot",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_smelt_claim_output_s1",
        action: "smelt_recipe",
        args: {
          item: "iron_ingot",
          count: 1,
          station: "furnace",
          input: "raw_iron",
          inputCount: 1,
          ingredients: [{ name: "raw_iron", count: 1 }]
        },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    { reasoningEnabled: false },
    { id: 996, isCancelled: () => false, setStep() {}, reportProgress() {} },
    () => {}
  );

  assert.equal(result.status, "success");
  assert.equal(takeOutputCalls, 1);
  assert.equal(putInputCalls, 0);
  assert.equal(inventoryCount(bot, "iron_ingot"), 1);
});

test("craft_recipe preflight acquires missing iron_ingot via dependency subplan instead of unsupported-item failure", async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const craftingTableBlockId = mcData.blocksByName.crafting_table.id;
  const furnaceBlockId = mcData.blocksByName.furnace.id;
  const ironChestplateId = mcData.itemsByName.iron_chestplate.id;
  const ironIngotId = mcData.itemsByName.iron_ingot.id;
  const rawIronId = mcData.itemsByName.raw_iron.id;
  const coalId = mcData.itemsByName.coal.id;
  const tablePos = new Vec3(1, 64, 0);
  const furnacePos = new Vec3(2, 64, 0);
  const inv = [
    { name: "iron_ingot", type: ironIngotId, count: 6 },
    { name: "raw_iron", type: rawIronId, count: 2 },
    { name: "coal", type: coalId, count: 1 }
  ];
  const events = [];
  let furnaceInput = 0;
  let furnaceFuel = 0;
  let furnaceOutput = 0;

  function row(name) {
    return inv.find((entry) => entry.name === name && Number(entry.count || 0) > 0) || null;
  }

  function addItem(name, type, count) {
    if (count <= 0) return;
    const existing = row(name);
    if (existing) existing.count += count;
    else inv.push({ name, type, count });
  }

  function takeItem(name, count) {
    let left = Math.max(0, Number(count || 0));
    for (const entry of inv) {
      if (entry.name !== name || left <= 0) continue;
      const moved = Math.min(Number(entry.count || 0), left);
      entry.count -= moved;
      left -= moved;
    }
    return left <= 0;
  }

  const furnace = {
    outputItem: () => (furnaceOutput > 0 ? { type: ironIngotId, name: "iron_ingot", count: furnaceOutput } : null),
    inputItem: () => (furnaceInput > 0 ? { type: rawIronId, name: "raw_iron", count: furnaceInput } : null),
    fuelItem: () => (furnaceFuel > 0 ? { type: coalId, name: "coal", count: furnaceFuel } : null),
    putFuel: async (_type, _meta, count) => {
      const needed = Math.max(1, Number(count || 0));
      if (!takeItem("coal", needed)) throw new Error("missing coal");
      furnaceFuel += needed;
    },
    putInput: async (_type, _meta, count) => {
      const needed = Math.max(1, Number(count || 0));
      if (!takeItem("raw_iron", needed)) throw new Error("missing raw_iron");
      furnaceInput += needed;
      const produced = Math.min(furnaceInput, furnaceFuel * 8);
      furnaceInput -= produced;
      furnaceOutput += produced;
    },
    takeOutput: async () => {
      if (furnaceOutput <= 0) throw new Error("no output");
      addItem("iron_ingot", ironIngotId, furnaceOutput);
      furnaceOutput = 0;
      furnaceFuel = 0;
    },
    close() {}
  };

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv.filter((entry) => Number(entry.count || 0) > 0) },
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      },
      setMovements() {}
    },
    findBlock: ({ matching }) => {
      if (matching === craftingTableBlockId) {
        return { position: tablePos, name: "crafting_table", boundingBox: "block" };
      }
      if (matching === furnaceBlockId) {
        return { position: furnacePos, name: "furnace", boundingBox: "block" };
      }
      return null;
    },
    blockAt: (pos) => {
      if (!pos) return null;
      if (pos.x === tablePos.x && pos.y === tablePos.y && pos.z === tablePos.z) {
        return { position: pos, name: "crafting_table", boundingBox: "block" };
      }
      if (pos.x === furnacePos.x && pos.y === furnacePos.y && pos.z === furnacePos.z) {
        return { position: pos, name: "furnace", boundingBox: "block" };
      }
      if (pos.y === 63) return { position: pos, name: "stone", boundingBox: "block" };
      return { position: pos, name: "air", boundingBox: "empty" };
    },
    recipesFor: (itemId, _meta, _count, table) => {
      if (itemId === ironChestplateId) {
        if (!table?.position) return [];
        return inventoryCount(bot, "iron_ingot") >= 8 ? [{ id: "recipe_iron_chestplate" }] : [];
      }
      return [];
    },
    craft: async (_recipe, count) => {
      if (!takeItem("iron_ingot", 8 * Math.max(1, Number(count || 1)))) {
        throw new Error("missing iron_ingot");
      }
      addItem("iron_chestplate", ironChestplateId, Math.max(1, Number(count || 1)));
    },
    openFurnace: async () => furnace,
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_chestplate_missing_ingots",
    item: "iron_chestplate",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_chestplate_missing_ingots_s1",
        action: "craft_recipe",
        args: {
          item: "iron_chestplate",
          count: 1,
          station: "crafting_table",
          processType: "craft",
          outputItem: "iron_chestplate",
          ingredients: [{ name: "iron_ingot", count: 8 }]
        },
        retryPolicy: {},
        timeoutMs: 2000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    { reasoningEnabled: false, dependencyPlannerEnabled: true, intelligenceEnabled: true },
    { id: 997, isCancelled: () => false, setStep() {}, reportProgress() {} },
    (evt) => events.push(evt)
  );

  assert.equal(result.status, "success");
  assert.equal(inventoryCount(bot, "iron_chestplate"), 1);
  assert.equal(events.some((e) => e.type === "ensure_item_subplan_start" && e.item === "iron_ingot"), true);
  assert.equal(events.some((e) => String(e.reason || "").includes("unsupported craft item iron_ingot")), false);
});

test("smelt_recipe inserts enough sticks to complete one smelt", async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const furnaceBlockId = mcData.blocksByName.furnace.id;
  const stickId = mcData.itemsByName.stick.id;
  const rawIronId = mcData.itemsByName.raw_iron.id;
  const ironIngotId = mcData.itemsByName.iron_ingot.id;
  const inv = [
    { name: "raw_iron", type: rawIronId, count: 1 },
    { name: "stick", type: stickId, count: 2 }
  ];
  let fuelCount = 0;
  let outputCount = 0;
  let insertedFuelCount = 0;

  function row(name) {
    return inv.find((r) => r.name === name);
  }

  const furnace = {
    outputItem: () => (outputCount > 0 ? { type: ironIngotId, name: "iron_ingot", count: outputCount } : null),
    inputItem: () => null,
    fuelItem: () => (fuelCount > 0 ? { type: stickId, name: "stick", count: fuelCount } : null),
    putFuel: async (_type, _meta, count) => {
      insertedFuelCount += Number(count || 0);
      const stick = row("stick");
      if (!stick || stick.count < count) throw new Error("missing sticks");
      stick.count -= count;
      if (stick.count <= 0) inv.splice(inv.indexOf(stick), 1);
      fuelCount += Number(count || 0);
    },
    putInput: async () => {
      const raw = row("raw_iron");
      if (!raw || raw.count < 1) throw new Error("missing raw iron");
      raw.count -= 1;
      if (raw.count <= 0) inv.splice(inv.indexOf(raw), 1);
      if (fuelCount >= 2) {
        fuelCount -= 2;
        outputCount += 1;
      }
    },
    takeOutput: async () => {
      if (outputCount < 1) throw new Error("no output");
      outputCount -= 1;
      const ingot = row("iron_ingot");
      if (ingot) ingot.count += 1;
      else inv.push({ name: "iron_ingot", type: ironIngotId, count: 1 });
    },
    close: () => {}
  };

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv },
    findBlock: ({ matching }) => (matching === furnaceBlockId ? { position: new Vec3(1, 64, 0), name: "furnace", boundingBox: "block" } : null),
    openFurnace: async () => furnace,
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_smelt_stick_fuel",
    item: "iron_ingot",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_smelt_stick_fuel_s1",
        action: "smelt_recipe",
        args: {
          item: "iron_ingot",
          count: 1,
          station: "furnace",
          input: "raw_iron",
          inputCount: 1,
          ingredients: [{ name: "raw_iron", count: 1 }]
        },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    { reasoningEnabled: false, fuelPolicy: "inventory_first_then_charcoal_then_coal" },
    { id: 997, isCancelled: () => false, setStep() {}, reportProgress() {} },
    () => {}
  );

  assert.equal(result.status, "success");
  assert.equal(insertedFuelCount >= 2, true);
  assert.equal(inventoryCount(bot, "iron_ingot"), 1);
});

test("smelt_recipe batches input and fuel for multi-count smelt", async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const furnaceBlockId = mcData.blocksByName.furnace.id;
  const stickId = mcData.itemsByName.stick.id;
  const coalId = mcData.itemsByName.coal.id;
  const rawIronId = mcData.itemsByName.raw_iron.id;
  const ironIngotId = mcData.itemsByName.iron_ingot.id;
  const coalPos = new Vec3(3, 64, 0);
  const inv = [
    { name: "raw_iron", type: rawIronId, count: 3 },
    { name: "stick", type: stickId, count: 6 }
  ];
  let coalBroken = false;
  let fuelCount = 0;
  let inputCount = 0;
  let outputCount = 0;
  let putInputCalls = 0;
  let putFuelCalls = 0;
  let insertedInput = 0;
  let insertedFuel = 0;

  function row(name) {
    return inv.find((r) => r.name === name);
  }

  function addInv(name, type, count) {
    const existing = row(name);
    if (existing) existing.count += count;
    else inv.push({ name, type, count });
  }

  const furnace = {
    outputItem: () => (outputCount > 0 ? { type: ironIngotId, name: "iron_ingot", count: outputCount } : null),
    inputItem: () => (inputCount > 0 ? { type: rawIronId, name: "raw_iron", count: inputCount } : null),
    fuelItem: () => (fuelCount > 0 ? { type: stickId, name: "stick", count: fuelCount } : null),
    putFuel: async (_type, _meta, count) => {
      putFuelCalls += 1;
      insertedFuel += Number(count || 0);
      const stick = row("stick");
      if (!stick || stick.count < count) throw new Error("missing sticks");
      stick.count -= count;
      if (stick.count <= 0) inv.splice(inv.indexOf(stick), 1);
      fuelCount += Number(count || 0);
    },
    putInput: async (_type, _meta, count) => {
      putInputCalls += 1;
      insertedInput += Number(count || 0);
      const raw = row("raw_iron");
      if (!raw || raw.count < count) throw new Error("missing raw iron");
      raw.count -= count;
      if (raw.count <= 0) inv.splice(inv.indexOf(raw), 1);
      inputCount += Number(count || 0);
    },
    takeOutput: async () => {
      if (outputCount < 1) throw new Error("no output");
      outputCount -= 1;
      addInv("iron_ingot", ironIngotId, 1);
    },
    close: () => {}
  };

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      },
      setMovements() {}
    },
    inventory: { items: () => inv.filter((r) => Number(r.count || 0) > 0) },
    findBlocks: ({ matching }) => {
      const sample = { name: "coal_ore", position: coalPos };
      return matching(sample) ? [coalPos] : [];
    },
    findBlock: ({ matching }) => (matching === furnaceBlockId ? { position: new Vec3(1, 64, 0), name: "furnace", boundingBox: "block" } : null),
    blockAt: (pos) => {
      if (!pos) return null;
      if (pos.y === 63) return { position: pos, name: "stone", boundingBox: "block" };
      if (pos.x === 1 && pos.y === 64 && pos.z === 0) return { position: pos, name: "furnace", boundingBox: "block" };
      if (pos.x === coalPos.x && pos.y === coalPos.y && pos.z === coalPos.z) {
        if (coalBroken) return { position: pos, name: "air", boundingBox: "empty" };
        return { position: pos, name: "coal_ore", boundingBox: "block" };
      }
      return { position: pos, name: "air", boundingBox: "empty" };
    },
    dig: async (block) => {
      if (block?.name === "coal_ore" && !coalBroken) {
        coalBroken = true;
        addInv("coal", coalId, 1);
      }
    },
    openFurnace: async () => furnace,
    waitForTicks: async () => {
      if (inputCount > 0 && fuelCount >= 2) {
        inputCount -= 1;
        fuelCount -= 2;
        outputCount += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_smelt_batch_multi",
    item: "iron_ingot",
    count: 3,
    constraints: { timeoutSec: 30 },
    steps: [
      {
        id: "goal_smelt_batch_multi_s1",
        action: "smelt_recipe",
        args: {
          item: "iron_ingot",
          count: 3,
          station: "furnace",
          input: "raw_iron",
          inputCount: 3,
          ingredients: [{ name: "raw_iron", count: 3 }]
        },
        retryPolicy: {},
        timeoutMs: 4000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    { reasoningEnabled: false, fuelPolicy: "inventory_first_then_charcoal_then_coal" },
    { id: 9971, isCancelled: () => false, setStep() {}, reportProgress() {} },
    () => {}
  );

  assert.equal(result.status, "success");
  assert.equal(putInputCalls, 1);
  assert.equal(insertedInput, 3);
  assert.equal(putFuelCalls >= 1, true);
  assert.equal(insertedFuel >= 6, true);
  assert.equal(inventoryCount(bot, "iron_ingot"), 3);
});

test("smelt_recipe detects furnace output by item name when type is missing", async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const furnaceBlockId = mcData.blocksByName.furnace.id;
  const rawIronId = mcData.itemsByName.raw_iron.id;
  const inv = [{ name: "raw_iron", type: rawIronId, count: 1 }, { name: "coal", count: 1 }];
  let outputCount = 0;

  function row(name) {
    return inv.find((r) => r.name === name);
  }

  const furnace = {
    outputItem: () => (outputCount > 0 ? { name: "iron_ingot", count: outputCount } : null),
    inputItem: () => null,
    fuelItem: () => ({ name: "coal", count: 1 }),
    putFuel: async () => {},
    putInput: async () => {
      const raw = row("raw_iron");
      if (raw) raw.count = 0;
      outputCount = 1;
    },
    takeOutput: async () => {
      outputCount = 0;
      inv.push({ name: "iron_ingot", count: 1 });
    },
    close: () => {}
  };

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv.filter((r) => Number(r.count || 0) > 0) },
    findBlock: ({ matching }) => (matching === furnaceBlockId ? { position: new Vec3(1, 64, 0), name: "furnace", boundingBox: "block" } : null),
    openFurnace: async () => furnace,
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_smelt_output_name_match",
    item: "iron_ingot",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_smelt_output_name_match_s1",
        action: "smelt_recipe",
        args: {
          item: "iron_ingot",
          count: 1,
          station: "furnace",
          input: "raw_iron",
          inputCount: 1,
          ingredients: [{ name: "raw_iron", count: 1 }]
        },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    { reasoningEnabled: false },
    { id: 997, isCancelled: () => false, setStep() {}, reportProgress() {} },
    () => {}
  );

  assert.equal(result.status, "success");
  assert.equal(inventoryCount(bot, "iron_ingot"), 1);
});

test("smelt_recipe tolerates delayed inventory reflection after takeOutput", async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const furnaceBlockId = mcData.blocksByName.furnace.id;
  const rawIronId = mcData.itemsByName.raw_iron.id;
  const ironIngotId = mcData.itemsByName.iron_ingot.id;
  const inv = [{ name: "raw_iron", type: rawIronId, count: 1 }, { name: "coal", count: 1 }];
  let outputCount = 0;
  let pendingInventoryOutput = 0;
  let waitedTicks = 0;

  function row(name) {
    return inv.find((r) => r.name === name);
  }

  const furnace = {
    outputItem: () => (outputCount > 0 ? { type: ironIngotId, name: "iron_ingot", count: outputCount } : null),
    inputItem: () => null,
    fuelItem: () => ({ name: "coal", count: 1 }),
    putFuel: async () => {},
    putInput: async () => {
      const raw = row("raw_iron");
      if (raw) raw.count = 0;
      outputCount = 1;
    },
    takeOutput: async () => {
      if (outputCount < 1) throw new Error("no output");
      outputCount = 0;
      pendingInventoryOutput += 1;
    },
    close: () => {}
  };

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv.filter((r) => Number(r.count || 0) > 0) },
    findBlock: ({ matching }) => (matching === furnaceBlockId ? { position: new Vec3(1, 64, 0), name: "furnace", boundingBox: "block" } : null),
    openFurnace: async () => furnace,
    waitForTicks: async (ticks = 1) => {
      waitedTicks += Math.max(1, Number(ticks || 1));
      if (pendingInventoryOutput > 0 && waitedTicks >= 8) {
        pendingInventoryOutput -= 1;
        inv.push({ name: "iron_ingot", type: ironIngotId, count: 1 });
      }
    }
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_smelt_delayed_inventory_sync",
    item: "iron_ingot",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_smelt_delayed_inventory_sync_s1",
        action: "smelt_recipe",
        args: {
          item: "iron_ingot",
          count: 1,
          station: "furnace",
          input: "raw_iron",
          inputCount: 1,
          ingredients: [{ name: "raw_iron", count: 1 }]
        },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    { reasoningEnabled: false },
    { id: 9972, isCancelled: () => false, setStep() {}, reportProgress() {} },
    () => {}
  );

  assert.equal(result.status, "success");
  assert.equal(inventoryCount(bot, "iron_ingot"), 1);
  assert.equal(waitedTicks >= 8, true);
});

test("smelt_recipe no-fuel failure asks for any furnace fuel (not coal-only)", async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const furnaceBlockId = mcData.blocksByName.furnace.id;
  const rawIronId = mcData.itemsByName.raw_iron.id;
  const inv = [{ name: "raw_iron", type: rawIronId, count: 1 }];

  const furnace = {
    outputItem: () => null,
    inputItem: () => null,
    fuelItem: () => null,
    putFuel: async () => { throw new Error("no fuel"); },
    putInput: async () => {},
    takeOutput: async () => {},
    close: () => {}
  };

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv },
    findBlock: ({ matching }) => (matching === furnaceBlockId ? { position: new Vec3(1, 64, 0), name: "furnace", boundingBox: "block" } : null),
    openFurnace: async () => furnace,
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_smelt_no_fuel_message",
    item: "iron_ingot",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_smelt_no_fuel_message_s1",
        action: "smelt_recipe",
        args: {
          item: "iron_ingot",
          count: 1,
          station: "furnace",
          input: "raw_iron",
          inputCount: 1,
          ingredients: [{ name: "raw_iron", count: 1 }]
        },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    { reasoningEnabled: false, autoAcquireSmeltFuel: false },
    { id: 998, isCancelled: () => false, setStep() {}, reportProgress() {} },
    () => {}
  );

  assert.equal(result.status, "fail");
  assert.equal(result.code, "smelt_no_fuel");
  assert.equal(String(result.nextNeed || "").includes("any furnace fuel"), true);
  assert.equal(String(result.nextNeed || "").includes("coal or charcoal"), false);
});

test("ensure_item log uses gather_block path and avoids legacy collectBlock", { timeout: 15000 }, async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const logId = mcData.itemsByName.oak_log.id;
  const logPos = new Vec3(2, 64, 0);
  const inv = [];
  const events = [];
  let logBroken = false;
  let collectCalled = false;

  function addInv(name, type, count) {
    const row = inv.find((r) => r.name === name);
    if (row) row.count += count;
    else inv.push({ name, type, count });
  }

  function takeInvByName(name, count) {
    const row = inv.find((r) => r.name === name);
    if (!row || row.count < count) return false;
    row.count -= count;
    if (row.count <= 0) inv.splice(inv.indexOf(row), 1);
    return true;
  }

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    heldItem: null,
    entities: {},
    inventory: { items: () => inv.filter((r) => Number(r.count || 0) > 0) },
    collectBlock: {
      collect: async () => {
        collectCalled = true;
        throw new Error("legacy collect should not be used");
      }
    },
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      },
      setMovements() {}
    },
    findBlocks: ({ matching }) => {
      const sample = { name: "oak_log", position: logPos };
      return matching(sample) ? [logPos] : [];
    },
    blockAt: (pos) => {
      if (!pos) return null;
      if (pos.y === 63) return { position: pos, name: "stone", boundingBox: "block" };
      if (pos.x === logPos.x && pos.y === logPos.y && pos.z === logPos.z) {
        if (logBroken) return { position: pos, name: "air", boundingBox: "empty" };
        return { position: pos, name: "oak_log", boundingBox: "block" };
      }
      return { position: pos, name: "air", boundingBox: "empty" };
    },
    dig: async (block) => {
      if (block?.name === "oak_log" && !logBroken) {
        logBroken = true;
        addInv("oak_log", logId, 1);
      }
    },
    waitForTicks: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };

  const plan = {
    item: "log",
    count: 1,
    steps: [
      {
        action: "ensure_item",
        item: "log",
        count: 1
      }
    ]
  };

  const result = await executeCraftPlan(
    bot,
    plan,
    {
      reasoningEnabled: false,
      strictHarvestToolGate: false,
      gatherRadiusSteps: [16],
      gatherExpandRetryPerRing: 1
    },
    { isCancelled: () => false },
    (evt) => events.push(evt)
  );

  assert.equal(result.status, "success");
  assert.equal(collectCalled, false);
  assert.equal(inventoryCount(bot, "log"), 1);
  assert.equal(events.some((e) => e.type === "gather_target_selected" && e.item === "log"), true);
});

test("smelt_recipe auto-acquire honors preferred fuel order and does not force log-first", { timeout: 15000 }, async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const furnaceBlockId = mcData.blocksByName.furnace.id;
  const rawIronId = mcData.itemsByName.raw_iron.id;
  const ironIngotId = mcData.itemsByName.iron_ingot.id;
  const coalId = mcData.itemsByName.coal.id;
  const logId = mcData.itemsByName.oak_log.id;
  const furnacePos = new Vec3(1, 64, 0);
  const coalPos = new Vec3(2, 64, 0);
  const logPos = new Vec3(3, 64, 0);
  const inv = [{ name: "raw_iron", type: rawIronId, count: 1 }];
  const events = [];
  let coalBroken = false;
  let logBroken = false;
  let outputCount = 0;
  let fuelOps = 0;

  function addInv(name, type, count) {
    const row = inv.find((r) => r.name === name);
    if (row) row.count += count;
    else inv.push({ name, type, count });
  }

  function takeInvByName(name, count) {
    const row = inv.find((r) => r.name === name);
    if (!row || row.count < count) return false;
    row.count -= count;
    if (row.count <= 0) inv.splice(inv.indexOf(row), 1);
    return true;
  }

  const furnace = {
    outputItem: () => (outputCount > 0 ? { type: ironIngotId, name: "iron_ingot", count: outputCount } : null),
    inputItem: () => null,
    fuelItem: () => null,
    putFuel: async (_type, _meta, count) => {
      const needed = Number(count || 0);
      if (takeInvByName("coal", needed)) {
        fuelOps += needed * 8;
        return;
      }
      if (takeInvByName("oak_log", needed)) {
        fuelOps += needed * 1.5;
        return;
      }
      throw new Error("missing fuel");
    },
    putInput: async (_type, _meta, count) => {
      const needed = Number(count || 0);
      if (!takeInvByName("raw_iron", needed)) throw new Error("missing raw iron");
      const smelted = Math.min(needed, Math.floor(fuelOps));
      fuelOps = Math.max(0, fuelOps - smelted);
      outputCount += smelted;
    },
    takeOutput: async () => {
      if (outputCount < 1) throw new Error("no output");
      outputCount -= 1;
      addInv("iron_ingot", ironIngotId, 1);
    },
    close: () => {}
  };

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    heldItem: null,
    entities: {},
    inventory: { items: () => inv.filter((r) => Number(r.count || 0) > 0) },
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      },
      setMovements() {}
    },
    findBlocks: ({ matching }) => {
      const out = [];
      const coalSample = { name: "coal_ore", position: coalPos };
      const logSample = { name: "oak_log", position: logPos };
      if (matching(coalSample)) out.push(coalPos);
      if (matching(logSample)) out.push(logPos);
      return out;
    },
    findBlock: ({ matching }) => (matching === furnaceBlockId ? { position: furnacePos, name: "furnace", boundingBox: "block" } : null),
    blockAt: (pos) => {
      if (!pos) return null;
      if (pos.y === 63) return { position: pos, name: "stone", boundingBox: "block" };
      if (pos.x === furnacePos.x && pos.y === furnacePos.y && pos.z === furnacePos.z) {
        return { position: pos, name: "furnace", boundingBox: "block" };
      }
      if (pos.x === coalPos.x && pos.y === coalPos.y && pos.z === coalPos.z) {
        if (coalBroken) return { position: pos, name: "air", boundingBox: "empty" };
        return { position: pos, name: "coal_ore", boundingBox: "block" };
      }
      if (pos.x === logPos.x && pos.y === logPos.y && pos.z === logPos.z) {
        if (logBroken) return { position: pos, name: "air", boundingBox: "empty" };
        return { position: pos, name: "oak_log", boundingBox: "block" };
      }
      return { position: pos, name: "air", boundingBox: "empty" };
    },
    dig: async (block) => {
      if (block?.name === "coal_ore" && !coalBroken) {
        coalBroken = true;
        addInv("coal", coalId, 1);
        return;
      }
      if (block?.name === "oak_log" && !logBroken) {
        logBroken = true;
        addInv("oak_log", logId, 1);
      }
    },
    openFurnace: async () => furnace,
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_smelt_ordered_fuel",
    item: "iron_ingot",
    count: 1,
    constraints: { timeoutSec: 30 },
    steps: [
      {
        id: "goal_smelt_ordered_fuel_s1",
        action: "smelt_recipe",
        args: {
          item: "iron_ingot",
          count: 1,
          station: "furnace",
          input: "raw_iron",
          inputCount: 1,
          ingredients: [{ name: "raw_iron", count: 1 }]
        },
        retryPolicy: {},
        timeoutMs: 2000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      reasoningEnabled: false,
      autoAcquireSmeltFuel: true,
      strictHarvestToolGate: false,
      gatherRadiusSteps: [16],
      gatherExpandRetryPerRing: 1,
      fuelPolicy: "inventory_first_then_charcoal_then_coal"
    },
    { id: 1002, isCancelled: () => false, setStep() {}, reportProgress() {} },
    (evt) => events.push(evt)
  );

  assert.equal(result.status, "success");
  assert.equal(events.some((e) => e.type === "gather_target_selected" && e.item === "coal"), true);
  assert.equal(events.some((e) => e.type === "gather_target_selected" && e.item === "log"), false);
  assert.equal(events.some((e) => e.type === "smelt_fuel_batch" && e.fuel === "coal"), true);
});

test("smelt_recipe treats in-flight furnace input as buffered and avoids stale-slot reinsert fails", { timeout: 15000 }, async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const furnaceBlockId = mcData.blocksByName.furnace.id;
  const rawIronId = mcData.itemsByName.raw_iron.id;
  const ironIngotId = mcData.itemsByName.iron_ingot.id;
  const coalId = mcData.itemsByName.coal.id;
  const events = [];

  let reportedRawIron = 3;
  let realRawIron = 3;
  let coal = 1;
  let ironIngot = 0;
  let furnaceInput = 0;
  let inFlightCook = false;
  let furnaceOutput = 0;
  let burnOpsRemaining = 0;
  let putInputCalls = 0;

  const furnace = {
    outputItem: () => (furnaceOutput > 0 ? { type: ironIngotId, name: "iron_ingot", count: furnaceOutput } : null),
    inputItem: () => (furnaceInput > 0 ? { type: rawIronId, name: "raw_iron", count: furnaceInput } : null),
    fuelItem: () => null,
    putFuel: async (_type, _meta, count) => {
      const needed = Math.max(1, Number(count || 0));
      if (coal < needed) throw new Error(`Can't find coal in slots [3 - 39], (item id: ${coalId})`);
      coal -= needed;
      burnOpsRemaining += needed * 8;
    },
    putInput: async (_type, _meta, count) => {
      const needed = Math.max(1, Number(count || 0));
      putInputCalls += 1;
      if (realRawIron < needed) throw new Error(`Can't find raw_iron in slots [3 - 39], (item id: ${rawIronId})`);
      realRawIron -= needed;
      // Simulate stale inventory view where one raw_iron lingers in inventory list.
      reportedRawIron = Math.max(1, reportedRawIron - needed);
      furnaceInput += needed;
    },
    takeOutput: async () => {
      if (furnaceOutput <= 0) throw new Error("no output");
      furnaceOutput -= 1;
      ironIngot += 1;
    },
    close: () => {}
  };

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: {
      items: () => {
        const out = [];
        if (reportedRawIron > 0) out.push({ name: "raw_iron", type: rawIronId, count: reportedRawIron });
        if (coal > 0) out.push({ name: "coal", type: coalId, count: coal });
        if (ironIngot > 0) out.push({ name: "iron_ingot", type: ironIngotId, count: ironIngot });
        return out;
      }
    },
    findBlock: ({ matching }) => (matching === furnaceBlockId ? { position: new Vec3(1, 64, 0), name: "furnace", boundingBox: "block" } : null),
    openFurnace: async () => furnace,
    waitForTicks: async (ticks) => {
      const cycles = Math.max(1, Number(ticks || 1));
      for (let i = 0; i < cycles; i += 1) {
        if (burnOpsRemaining <= 0) continue;
        if (!inFlightCook && furnaceInput > 0) {
          furnaceInput -= 1;
          inFlightCook = true;
          continue;
        }
        if (inFlightCook) {
          furnaceOutput += 1;
          inFlightCook = false;
          burnOpsRemaining = Math.max(0, burnOpsRemaining - 1);
        }
      }
    }
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_smelt_inflight_input_buffered",
    item: "iron_ingot",
    count: 3,
    constraints: { timeoutSec: 30 },
    steps: [
      {
        id: "goal_smelt_inflight_input_buffered_s1",
        action: "smelt_recipe",
        args: {
          item: "iron_ingot",
          count: 3,
          station: "furnace",
          input: "raw_iron",
          inputCount: 3,
          ingredients: [{ name: "raw_iron", count: 3 }]
        },
        retryPolicy: {},
        timeoutMs: 3000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      reasoningEnabled: false,
      disableTimeouts: true,
      stepStallGuardMs: 1200,
      smeltInputTransferRetryLimit: 2,
      smeltNoStateChangeMs: 5000
    },
    { id: 10111, isCancelled: () => false, setStep() {}, reportProgress() {} },
    (evt) => events.push(evt)
  );

  assert.equal(result.status, "success");
  assert.equal(ironIngot >= 3, true);
  assert.equal(putInputCalls, 1);
  assert.equal(events.some((e) => e.type === "smelt_transfer_retry" && e.where === "put_input"), false);
});

test("gather search exits with explicit terminal failure (no silent stall)", { timeout: 15000 }, async () => {
  const events = [];

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    findBlocks: () => [],
    blockAt: (pos) => {
      if (!pos) return null;
      if (pos.y === 63) return { position: pos, name: "stone", boundingBox: "block" };
      return { position: pos, name: "air", boundingBox: "empty" };
    },
    waitForTicks: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_progress_aware_stall_guard",
    item: "cobblestone",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_progress_aware_stall_guard_s1",
        action: "gather_block",
        args: { item: "cobblestone", count: 1, blockNames: ["stone"], preferredBlocks: ["stone"] },
        retryPolicy: { maxCorrections: 0 },
        timeoutMs: 3000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      reasoningEnabled: false,
      disableTimeouts: true,
      stepStallGuardMs: 180,
      stepStallRetryCount: 0,
      gatherRadiusSteps: [8, 12],
      gatherExpandRetryPerRing: 2,
      strictHarvestToolGate: false
    },
    { id: 1003, isCancelled: () => false, setStep() {}, reportProgress() {} },
    (evt) => events.push(evt)
  );

  assert.equal(result.status, "fail");
  assert.equal(result.code, "path_blocked");
  assert.equal(events.some((e) => e.type === "step_stall"), false);
});

test("disableTimeouts still enforces inactivity stall guard for hanging smelt transfer", { timeout: 15000 }, async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const furnaceBlockId = mcData.blocksByName.furnace.id;
  const rawIronId = mcData.itemsByName.raw_iron.id;
  const coalId = mcData.itemsByName.coal.id;
  const inv = [
    { name: "raw_iron", type: rawIronId, count: 1 },
    { name: "coal", type: coalId, count: 1 }
  ];
  const events = [];

  const furnace = {
    outputItem: () => null,
    inputItem: () => null,
    fuelItem: () => null,
    putFuel: async () => new Promise(() => {}),
    putInput: async () => {},
    takeOutput: async () => {},
    close: () => {}
  };

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv },
    findBlock: ({ matching }) => (matching === furnaceBlockId ? { position: new Vec3(1, 64, 0), name: "furnace", boundingBox: "block" } : null),
    openFurnace: async () => furnace,
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_disable_timeouts_inactivity_guard",
    item: "iron_ingot",
    count: 1,
    constraints: { timeoutSec: 30 },
    steps: [
      {
        id: "goal_disable_timeouts_inactivity_guard_s1",
        action: "smelt_recipe",
        args: {
          item: "iron_ingot",
          count: 1,
          station: "furnace",
          input: "raw_iron",
          inputCount: 1,
          ingredients: [{ name: "raw_iron", count: 1 }]
        },
        retryPolicy: {},
        timeoutMs: 3000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      reasoningEnabled: false,
      disableTimeouts: true,
      stepStallGuardMs: 120,
      stepStallRetryCount: 0
    },
    { id: 1004, isCancelled: () => false, setStep() {}, reportProgress() {} },
    (evt) => events.push(evt)
  );

  assert.equal(result.status, "fail");
  assert.equal(result.code, "step_stalled");
  assert.equal(events.some((e) => e.type === "step_stall" && Number(e.inactivityMs || 0) >= 120), true);
});

test("smelt put_fuel missing-slot error triggers bounded retry and recovery", { timeout: 15000 }, async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const furnaceBlockId = mcData.blocksByName.furnace.id;
  const rawIronId = mcData.itemsByName.raw_iron.id;
  const coalId = mcData.itemsByName.coal.id;
  const ironIngotId = mcData.itemsByName.iron_ingot.id;
  const inv = [
    { name: "raw_iron", type: rawIronId, count: 1 },
    { name: "coal", type: coalId, count: 1 }
  ];
  const events = [];
  let outputCount = 0;
  let putFuelCalls = 0;

  function row(name) {
    return inv.find((r) => r.name === name);
  }

  const furnace = {
    outputItem: () => (outputCount > 0 ? { type: ironIngotId, name: "iron_ingot", count: outputCount } : null),
    inputItem: () => null,
    fuelItem: () => null,
    putFuel: async () => {
      putFuelCalls += 1;
      if (putFuelCalls === 1) {
        throw new Error("Can't find coal in slots [3 - 39], (item id: 263)");
      }
      const coal = row("coal");
      if (!coal || coal.count < 1) throw new Error("missing coal");
      coal.count -= 1;
      if (coal.count <= 0) inv.splice(inv.indexOf(coal), 1);
    },
    putInput: async () => {
      const raw = row("raw_iron");
      if (!raw || raw.count < 1) throw new Error("missing raw iron");
      raw.count -= 1;
      if (raw.count <= 0) inv.splice(inv.indexOf(raw), 1);
      outputCount += 1;
    },
    takeOutput: async () => {
      if (outputCount < 1) throw new Error("no output");
      outputCount -= 1;
      inv.push({ name: "iron_ingot", type: ironIngotId, count: 1 });
    },
    close: () => {}
  };

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv.filter((r) => Number(r.count || 0) > 0) },
    findBlock: ({ matching }) => (matching === furnaceBlockId ? { position: new Vec3(1, 64, 0), name: "furnace", boundingBox: "block" } : null),
    openFurnace: async () => furnace,
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_smelt_recover_put_fuel_retry",
    item: "iron_ingot",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_smelt_recover_put_fuel_retry_s1",
        action: "smelt_recipe",
        args: {
          item: "iron_ingot",
          count: 1,
          station: "furnace",
          input: "raw_iron",
          inputCount: 1,
          ingredients: [{ name: "raw_iron", count: 1 }]
        },
        retryPolicy: {},
        timeoutMs: 2000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      reasoningEnabled: false,
      disableTimeouts: true,
      smeltTransferRetryLimit: 3,
      smeltInputTransferRetryLimit: 3
    },
    { id: 1007, isCancelled: () => false, setStep() {}, reportProgress() {} },
    (evt) => events.push(evt)
  );

  assert.equal(result.status, "success");
  assert.equal(events.some((e) => e.type === "smelt_transfer_retry" && e.where === "put_fuel"), true);
  assert.equal(events.some((e) => e.type === "smelt_fuel_batch"), true);
});

test("smelt switches to alternate fuel when primary fuel transfer is slot-bugged", { timeout: 15000 }, async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const furnaceBlockId = mcData.blocksByName.furnace.id;
  const rawIronId = mcData.itemsByName.raw_iron.id;
  const coalId = mcData.itemsByName.coal.id;
  const stickId = mcData.itemsByName.stick.id;
  const ironIngotId = mcData.itemsByName.iron_ingot.id;
  const inv = [
    { name: "raw_iron", type: rawIronId, count: 1 },
    { name: "coal", type: coalId, count: 1 },
    { name: "stick", type: stickId, count: 2 }
  ];
  const events = [];
  let outputCount = 0;
  let fuelOps = 0;

  function row(name) {
    return inv.find((r) => r.name === name);
  }

  function consume(name, count) {
    const target = row(name);
    if (!target || Number(target.count || 0) < count) return false;
    target.count -= count;
    if (target.count <= 0) inv.splice(inv.indexOf(target), 1);
    return true;
  }

  const furnace = {
    outputItem: () => (outputCount > 0 ? { type: ironIngotId, name: "iron_ingot", count: outputCount } : null),
    inputItem: () => null,
    fuelItem: () => null,
    putFuel: async (type, _meta, count) => {
      const fuelType = Number(type);
      if (fuelType === coalId) {
        throw new Error("Can't find coal in slots [3 - 39], (item id: 263)");
      }
      if (fuelType === stickId) {
        const needed = Math.max(1, Number(count || 1));
        if (!consume("stick", needed)) throw new Error("missing sticks");
        fuelOps += Math.floor(needed * 0.5);
        return;
      }
      throw new Error(`unexpected fuel type ${fuelType}`);
    },
    putInput: async () => {
      if (!consume("raw_iron", 1)) throw new Error("missing raw iron");
      if (fuelOps < 1) throw new Error("missing fuel ops");
      fuelOps -= 1;
      outputCount += 1;
    },
    takeOutput: async () => {
      if (outputCount < 1) throw new Error("no output");
      outputCount -= 1;
      inv.push({ name: "iron_ingot", type: ironIngotId, count: 1 });
    },
    close: () => {}
  };

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv.filter((r) => Number(r.count || 0) > 0) },
    findBlock: ({ matching }) => (matching === furnaceBlockId ? { position: new Vec3(1, 64, 0), name: "furnace", boundingBox: "block" } : null),
    openFurnace: async () => furnace,
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_smelt_fuel_failover",
    item: "iron_ingot",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_smelt_fuel_failover_s1",
        action: "smelt_recipe",
        args: {
          item: "iron_ingot",
          count: 1,
          station: "furnace",
          input: "raw_iron",
          inputCount: 1,
          ingredients: [{ name: "raw_iron", count: 1 }]
        },
        retryPolicy: {},
        timeoutMs: 2000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      reasoningEnabled: false,
      disableTimeouts: true,
      smeltTransferRetryLimit: 4,
      smeltInputTransferRetryLimit: 3
    },
    { id: 10071, isCancelled: () => false, setStep() {}, reportProgress() {} },
    (evt) => events.push(evt)
  );

  assert.equal(result.status, "success");
  assert.equal(events.some((e) => e.type === "smelt_fuel_rejected" && e.fuel === "coal"), true);
  assert.equal(events.some((e) => e.type === "smelt_fuel_fallback" && e.to === "stick"), true);
  assert.equal(events.some((e) => e.type === "smelt_fuel_batch" && e.fuel === "stick"), true);
});

test("smelt transfer retries are bounded and end with explicit smelt_transfer_failed", { timeout: 15000 }, async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const furnaceBlockId = mcData.blocksByName.furnace.id;
  const rawIronId = mcData.itemsByName.raw_iron.id;
  const coalId = mcData.itemsByName.coal.id;
  const inv = [
    { name: "raw_iron", type: rawIronId, count: 1 },
    { name: "coal", type: coalId, count: 1 }
  ];
  const events = [];

  const furnace = {
    outputItem: () => null,
    inputItem: () => null,
    fuelItem: () => null,
    putFuel: async () => {
      throw new Error("Can't find coal in slots [3 - 39], (item id: 263)");
    },
    putInput: async () => {},
    takeOutput: async () => {},
    close: () => {}
  };

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv.filter((r) => Number(r.count || 0) > 0) },
    findBlock: ({ matching }) => (matching === furnaceBlockId ? { position: new Vec3(1, 64, 0), name: "furnace", boundingBox: "block" } : null),
    openFurnace: async () => furnace,
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_smelt_bounded_transfer_fail",
    item: "iron_ingot",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_smelt_bounded_transfer_fail_s1",
        action: "smelt_recipe",
        args: {
          item: "iron_ingot",
          count: 1,
          station: "furnace",
          input: "raw_iron",
          inputCount: 1,
          ingredients: [{ name: "raw_iron", count: 1 }]
        },
        retryPolicy: {},
        timeoutMs: 2000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      reasoningEnabled: false,
      disableTimeouts: true,
      stepStallGuardMs: 10000,
      smeltTransferRetryLimit: 2
    },
    { id: 1008, isCancelled: () => false, setStep() {}, reportProgress() {} },
    (evt) => events.push(evt)
  );

  assert.equal(result.status, "fail");
  assert.equal(result.code, "smelt_transfer_failed");
  assert.equal(events.filter((e) => e.type === "smelt_transfer_retry" && e.where === "put_fuel").length >= 3, true);
});

test("heartbeat-only smelt wait does not reset inactivity stall guard", { timeout: 15000 }, async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const furnaceBlockId = mcData.blocksByName.furnace.id;
  const rawIronId = mcData.itemsByName.raw_iron.id;
  const coalId = mcData.itemsByName.coal.id;
  const events = [];

  const furnace = {
    outputItem: () => null,
    inputItem: () => ({ type: rawIronId, name: "raw_iron", count: 2 }),
    fuelItem: () => ({ type: coalId, name: "coal", count: 1 }),
    putFuel: async () => { throw new Error("unexpected putFuel"); },
    putInput: async () => { throw new Error("unexpected putInput"); },
    takeOutput: async () => {}
  };

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    findBlock: ({ matching }) => (matching === furnaceBlockId ? { position: new Vec3(1, 64, 0), name: "furnace", boundingBox: "block" } : null),
    openFurnace: async () => furnace,
    waitForTicks: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_smelt_heartbeat_only_wait",
    item: "iron_ingot",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_smelt_heartbeat_only_wait_s1",
        action: "smelt_recipe",
        args: {
          item: "iron_ingot",
          count: 1,
          station: "furnace",
          input: "raw_iron",
          inputCount: 1,
          ingredients: [{ name: "raw_iron", count: 1 }]
        },
        retryPolicy: {},
        timeoutMs: 2000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      reasoningEnabled: false,
      disableTimeouts: true,
      stepStallGuardMs: 120,
      stepStallRetryCount: 0,
      smeltNoStateChangeMs: 100000
    },
    { id: 1009, isCancelled: () => false, setStep() {}, reportProgress() {} },
    (evt) => events.push(evt)
  );

  assert.equal(result.status, "fail");
  assert.equal(result.code, "step_stalled");
  assert.equal(events.some((e) => e.type === "step_stall"), true);
});

test("disableTimeouts default stall guard uses conservative 40s", () => {
  const gatherGuard = __test.configuredStepStallGuardMs({ action: "gather_block" }, { disableTimeouts: true });
  const smeltGuard = __test.configuredStepStallGuardMs({ action: "smelt_recipe", args: { count: 3 } }, { disableTimeouts: true });

  assert.equal(gatherGuard, 40000);
  assert.equal(smeltGuard, 40000);
});

test("drop recovery is bounded and returns explicit terminal failure (not silent stall)", { timeout: 15000 }, async () => {
  const events = [];
  const targetPos = new Vec3(1, 64, 0);
  const dropPos = new Vec3(4, 64, 0);
  let blockBroken = false;

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    entities: {},
    inventory: { items: () => [] },
    pathfinder: {
      setGoal(goal) {
        if (!goal) return;
        if (goal.x === targetPos.x && goal.y === targetPos.y && goal.z === targetPos.z) {
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
    canDigBlock: () => true,
    dig: async () => {
      blockBroken = true;
      bot.entities[404] = {
        id: 404,
        name: "item",
        type: "object",
        position: dropPos
      };
    },
    waitForTicks: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_drop_recovery_bounded",
    item: "cobblestone",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_drop_recovery_bounded_s1",
        action: "gather_block",
        args: { item: "cobblestone", count: 1, blockNames: ["stone"], preferredBlocks: ["stone"] },
        retryPolicy: {},
        timeoutMs: 4000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      reasoningEnabled: false,
      strictHarvestToolGate: false,
      gatherRadiusSteps: [16],
      gatherExpandRetryPerRing: 1,
      gatherDropRecoveryRetries: 1,
      gatherDropRecoverMoveTimeoutMs: 100,
      stepStallRetryCount: 0,
      stepStallGuardMs: 10000
    },
    { id: 1005, isCancelled: () => false, setStep() {}, reportProgress() {} },
    (evt) => events.push(evt)
  );

  assert.equal(result.status, "fail");
  assert.equal(result.code !== "step_stalled", true);
  assert.equal(events.some((e) => e.type === "gather_drop_recover_move"), true);
});

test("drop recovery ignores unrelated typed item entities", { timeout: 15000 }, async () => {
  const events = [];
  const targetPos = new Vec3(1, 64, 0);
  let blockBroken = false;

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    entities: {},
    inventory: { items: () => [] },
    pathfinder: {
      setGoal() {},
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
    canDigBlock: () => true,
    dig: async () => {
      blockBroken = true;
      bot.entities[505] = {
        id: 505,
        name: "item",
        type: "object",
        position: new Vec3(2, 64, 0),
        item: { name: "dirt" }
      };
    },
    waitForTicks: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_drop_recovery_typed_ignore",
    item: "cobblestone",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_drop_recovery_typed_ignore_s1",
        action: "gather_block",
        args: { item: "cobblestone", count: 1, blockNames: ["stone"], preferredBlocks: ["stone"] },
        retryPolicy: {},
        timeoutMs: 4000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      reasoningEnabled: false,
      strictHarvestToolGate: false,
      gatherRadiusSteps: [16],
      gatherExpandRetryPerRing: 1,
      gatherDropRecoveryRetries: 1,
      gatherDropRecoverMoveTimeoutMs: 100,
      stepStallRetryCount: 0,
      stepStallGuardMs: 10000
    },
    { id: 1006, isCancelled: () => false, setStep() {}, reportProgress() {} },
    (evt) => events.push(evt)
  );

  const dropScan = events.find((e) => e.type === "gather_drop_scan");
  assert.equal(result.status, "fail");
  assert.equal(result.code, "drop_recovery_failed");
  assert.equal(dropScan.totalDropCount, 1);
  assert.equal(dropScan.typedDropCount, 0);
  assert.equal(events.some((e) => e.type === "gather_drop_recover_move"), false);
});

test("smelt_recipe logs furnace state diagnostics while loading fuel/input", { timeout: 15000 }, async () => {
  const mcData = require("minecraft-data")("1.21.1");
  const furnaceBlockId = mcData.blocksByName.furnace.id;
  const stickId = mcData.itemsByName.stick.id;
  const rawIronId = mcData.itemsByName.raw_iron.id;
  const ironIngotId = mcData.itemsByName.iron_ingot.id;
  const inv = [
    { name: "raw_iron", type: rawIronId, count: 1 },
    { name: "stick", type: stickId, count: 2 }
  ];
  const events = [];
  let fuelCount = 0;
  let outputCount = 0;

  function row(name) {
    return inv.find((r) => r.name === name);
  }

  const furnace = {
    outputItem: () => (outputCount > 0 ? { type: ironIngotId, name: "iron_ingot", count: outputCount } : null),
    inputItem: () => null,
    fuelItem: () => (fuelCount > 0 ? { type: stickId, name: "stick", count: fuelCount } : null),
    putFuel: async (_type, _meta, count) => {
      const stick = row("stick");
      if (!stick || stick.count < count) throw new Error("missing sticks");
      stick.count -= count;
      if (stick.count <= 0) inv.splice(inv.indexOf(stick), 1);
      fuelCount += Number(count || 0);
    },
    putInput: async () => {
      const raw = row("raw_iron");
      if (!raw || raw.count < 1) throw new Error("missing raw iron");
      raw.count -= 1;
      if (raw.count <= 0) inv.splice(inv.indexOf(raw), 1);
      if (fuelCount >= 2) {
        fuelCount -= 2;
        outputCount += 1;
      }
    },
    takeOutput: async () => {
      if (outputCount < 1) throw new Error("no output");
      outputCount -= 1;
      inv.push({ name: "iron_ingot", type: ironIngotId, count: 1 });
    },
    close: () => {}
  };

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv },
    findBlock: ({ matching }) => (matching === furnaceBlockId ? { position: new Vec3(1, 64, 0), name: "furnace", boundingBox: "block" } : null),
    openFurnace: async () => furnace,
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_smelt_state_logging",
    item: "iron_ingot",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_smelt_state_logging_s1",
        action: "smelt_recipe",
        args: {
          item: "iron_ingot",
          count: 1,
          station: "furnace",
          input: "raw_iron",
          inputCount: 1,
          ingredients: [{ name: "raw_iron", count: 1 }]
        },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    { reasoningEnabled: false, fuelPolicy: "inventory_first_then_charcoal_then_coal" },
    { id: 1006, isCancelled: () => false, setStep() {}, reportProgress() {} },
    (evt) => events.push(evt)
  );

  assert.equal(result.status, "success");
  assert.equal(events.some((e) => e.type === "smelt_state"), true);
  assert.equal(events.some((e) => e.type === "smelt_fuel_batch"), true);
  assert.equal(events.some((e) => e.type === "smelt_input_batch"), true);
});
