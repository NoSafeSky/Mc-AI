const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");

const {
  canonicalInventory,
  buildCapabilitySnapshot
} = require("../brain/knowledge");

test("canonicalInventory prefers inventory.items() over slots", () => {
  const bot = {
    inventory: {
      items: () => [
        { name: "minecraft:oak_log", count: 2 },
        { name: "minecraft:stick", count: 4 }
      ],
      slots: [
        null,
        { name: "oak_log", count: 9 },
        { name: "minecraft:stick", count: 1 }
      ]
    }
  };

  const inv = canonicalInventory(bot);
  assert.equal(inv.oak_log, 2);
  assert.equal(inv.stick, 4);
});

test("canonicalInventory falls back to slots when items() is unavailable", () => {
  const bot = {
    inventory: {
      slots: [
        null,
        { name: "minecraft:oak_log", count: 2 },
        { name: "oak_log", count: 1 },
        { name: "minecraft:stick", count: 4 }
      ]
    }
  };

  const inv = canonicalInventory(bot);
  assert.equal(inv.oak_log, 3);
  assert.equal(inv.stick, 4);
});

test("buildCapabilitySnapshot detects stations/resources and tool tiers", () => {
  const mcData = require("minecraft-data")("1.21.1");
  const tableId = mcData.blocksByName.crafting_table.id;

  const bot = {
    version: "1.21.1",
    entity: {
      position: new Vec3(0, 64, 0)
    },
    inventory: {
      items: () => [
        { name: "minecraft:stone_pickaxe", count: 1 },
        { name: "minecraft:oak_log", count: 2 }
      ]
    },
    findBlock({ matching }) {
      if (typeof matching === "number") {
        if (matching === tableId) return { position: new Vec3(2, 64, 0), name: "crafting_table" };
        return null;
      }
      const sample = { name: "oak_log", position: new Vec3(1, 64, 1) };
      return matching(sample) ? sample : null;
    },
    collectBlock: { collect: async () => {} },
    pathfinder: { setGoal: () => {} }
  };

  const snap = buildCapabilitySnapshot(bot, {
    supportedStations: ["inventory", "crafting_table", "furnace"],
    autoGatherRadius: 32
  });

  assert.equal(snap.nearbyStations.inventory.available, true);
  assert.equal(snap.nearbyStations.crafting_table.available, true);
  assert.equal(snap.nearbyStations.furnace.available, false);
  assert.equal(snap.nearbyResources.logs.available, true);
  assert.equal(snap.equippedToolTiers.pickaxe, "stone");
  assert.equal(snap.environmentFlags.canCollectBlock, true);
  assert.equal(snap.environmentFlags.hasPathfinder, true);
});
