const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isCriticalItem,
  inventoryCountByName,
  stashStatus,
  giveItemToOwner
} = require("../brain/team_inventory");

test("isCriticalItem marks progression tools as critical", () => {
  assert.equal(isCriticalItem("iron_pickaxe"), true);
  assert.equal(isCriticalItem("dirt"), false);
});

test("inventoryCountByName counts normalized names", () => {
  const bot = {
    inventory: {
      items: () => [
        { name: "minecraft:oak_planks", count: 4 },
        { name: "oak_planks", count: 2 }
      ]
    }
  };
  assert.equal(inventoryCountByName(bot, "oak_planks"), 6);
});

test("stashStatus returns summary without stash", () => {
  const bot = {
    version: "1.21.1",
    inventory: {
      items: () => [
        { name: "iron_pickaxe", count: 1 },
        { name: "dirt", count: 8 }
      ]
    },
    findBlock: () => null
  };
  const out = stashStatus(bot, { teamStashRadius: 12 });
  assert.equal(out.stashFound, false);
  assert.equal(out.criticalCount > 0, true);
  assert.equal(out.nonCriticalCount > 0, true);
});

test("giveItemToOwner tosses requested item count", async () => {
  const tossed = [];
  const bot = {
    inventory: {
      items: () => [{ name: "cobblestone", count: 16, type: 1, metadata: null }]
    },
    toss: async (_type, _meta, count) => {
      tossed.push(count);
    }
  };
  const out = await giveItemToOwner(bot, "NoSafeSky", "cobblestone", 5, () => {});
  assert.equal(out.ok, true);
  assert.equal(out.given, 5);
  assert.equal(tossed.reduce((a, b) => a + b, 0), 5);
});
