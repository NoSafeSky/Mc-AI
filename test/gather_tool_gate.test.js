const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");

const { __test } = require("../brain/craft_executor");

function makeBot({ hasPickaxe = true } = {}) {
  const mcData = require("minecraft-data")("1.21.1");
  const stoneDef = mcData.blocksByName.stone;
  const blockPos = new Vec3(1, 64, 0);
  const inv = [];
  if (hasPickaxe) {
    inv.push({ name: "wooden_pickaxe", count: 1, slot: 36 });
  }

  const ensureItemRow = (name) => {
    let row = inv.find((i) => i.name === name);
    if (!row) {
      row = { name, count: 0, slot: 37 + inv.length };
      inv.push(row);
    }
    return row;
  };

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    heldItem: null,
    inventory: {
      slots: [],
      items: () => inv
    },
    pathfinder: { setGoal() {} },
    clearControlStates() {},
    findBlocks() {
      return [blockPos];
    },
    blockAt(pos) {
      if (!pos) return null;
      return {
        ...stoneDef,
        name: "stone",
        position: new Vec3(pos.x, pos.y, pos.z)
      };
    },
    async equip(item) {
      this.heldItem = item;
    },
    async dig() {
      const held = String(this.heldItem?.name || "");
      if (!held.includes("pickaxe")) return;
      const row = ensureItemRow("cobblestone");
      row.count += 1;
    },
    async waitForTicks() {}
  };

  return { bot, inv };
}

function runCtx() {
  return {
    cancelled: false,
    isCancelled() {
      return this.cancelled;
    },
    reportProgress() {}
  };
}

test("gather step equips compatible tool and succeeds", async () => {
  const { bot } = makeBot({ hasPickaxe: true });
  const events = [];
  const result = await __test.gatherBlockStep(
    bot,
    {
      item: "cobblestone",
      count: 1,
      blockNames: ["stone"],
      preferredBlocks: ["stone"]
    },
    {
      strictHarvestToolGate: true,
      autoAcquireRequiredTools: false,
      gatherRadiusSteps: [24],
      gatherExpandRetryPerRing: 1,
      gatherStepTimeoutSec: 12000
    },
    runCtx(),
    (evt) => events.push(evt)
  );

  assert.equal(result.ok, true);
  assert.equal(bot.heldItem?.name, "wooden_pickaxe");
  assert.equal(events.some((e) => e.type === "gather_tool_required"), true);
});

test("gather step fails explicitly when required tool is missing", async () => {
  const { bot } = makeBot({ hasPickaxe: false });
  const events = [];
  const result = await __test.gatherBlockStep(
    bot,
    {
      item: "cobblestone",
      count: 1,
      blockNames: ["stone"],
      preferredBlocks: ["stone"]
    },
    {
      strictHarvestToolGate: true,
      autoAcquireRequiredTools: false,
      gatherRadiusSteps: [24],
      gatherExpandRetryPerRing: 1,
      gatherStepTimeoutSec: 12000
    },
    runCtx(),
    (evt) => events.push(evt)
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "missing_required_tool");
  assert.equal(events.some((e) => e.type === "gather_tool_missing"), true);
});

test("gather step with valid pickaxe does not fail as tool_incompatible on no immediate pickup", async () => {
  const { bot } = makeBot({ hasPickaxe: true });
  bot.dig = async function () {
    // Simulate protected/odd server behavior: no inventory change even after dig call.
  };

  const result = await __test.gatherBlockStep(
    bot,
    {
      item: "cobblestone",
      count: 1,
      blockNames: ["stone"],
      preferredBlocks: ["stone"]
    },
    {
      strictHarvestToolGate: true,
      autoAcquireRequiredTools: false,
      gatherRadiusSteps: [24],
      gatherExpandRetryPerRing: 1,
      gatherStepTimeoutSec: 12000
    },
    runCtx(),
    () => {}
  );

  assert.equal(result.ok, false);
  assert.notEqual(result.code, "gather_tool_incompatible");
});
