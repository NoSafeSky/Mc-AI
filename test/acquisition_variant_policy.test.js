const test = require("node:test");
const assert = require("node:assert/strict");

const { getAcquisitionOptions } = require("../brain/acquisition_registry");

function baseCtx(snapshot = {}, cfgOverrides = {}) {
  return {
    mcData: require("minecraft-data")("1.21.1"),
    cfg: {
      recipeVariantPolicy: "overworld_safe",
      autoGatherEnabled: true,
      materialFlexPolicy: "inventory_first_any_wood",
      preferBambooForSticks: false,
      ...cfgOverrides
    },
    snapshot: {
      inventory: {},
      nearbyResources: {},
      ...snapshot
    },
    bot: { entities: {} }
  };
}

function firstCraftVariant(options) {
  return options.filter((o) => o.provider === "craft_recipe")[0];
}

test("stone_sword variant policy prefers cobblestone in overworld-safe mode", () => {
  const options = getAcquisitionOptions(
    "stone_sword",
    1,
    baseCtx({
      nearbyResources: {
        cobblestone: { available: true },
        cobbled_deepslate: { available: false },
        blackstone: { available: false }
      }
    })
  );

  const selected = firstCraftVariant(options);
  assert.ok(selected);
  assert.equal(selected.ingredients.some((i) => i.name === "cobblestone"), true);
});

test("inventory-ready deepslate variant can win despite overworld-safe preference", () => {
  const options = getAcquisitionOptions(
    "stone_sword",
    1,
    baseCtx({
      inventory: { cobbled_deepslate: 2, stick: 1 },
      nearbyResources: {
        cobblestone: { available: false },
        cobbled_deepslate: { available: true }
      }
    })
  );

  const selected = firstCraftVariant(options);
  assert.ok(selected);
  assert.equal(selected.ingredients.some((i) => i.name === "cobbled_deepslate"), true);
});

test("wood recipes prefer inventory species first then normalize to planks family", () => {
  const options = getAcquisitionOptions(
    "wooden_sword",
    1,
    baseCtx({
      inventory: { oak_planks: 4, stick: 2 },
      nearbyResources: { logs: { available: true } }
    })
  );
  const selected = firstCraftVariant(options);
  assert.ok(selected);
  assert.equal(selected.ingredients.some((i) => i.name === "planks"), true);
});

test("furnace from empty inventory prefers cobblestone path in overworld mode", () => {
  const options = getAcquisitionOptions(
    "furnace",
    1,
    baseCtx(
      {
        nearbyResources: {
          cobblestone: { available: true },
          cobbled_deepslate: { available: false },
          blackstone: { available: true }
        }
      },
      {
        craftCoverageMode: "overworld_v1",
        craftRecipeManifestVersion: "1.21.1-overworld-v1"
      }
    )
  );
  const selected = firstCraftVariant(options);
  assert.ok(selected);
  assert.equal(selected.ingredients.some((i) => i.name === "cobblestone"), true);
});

test("inventory-ready blackstone furnace variant can win in overworld mode", () => {
  const options = getAcquisitionOptions(
    "furnace",
    1,
    baseCtx(
      {
        inventory: { blackstone: 8 }
      },
      {
        craftCoverageMode: "overworld_v1",
        craftRecipeManifestVersion: "1.21.1-overworld-v1"
      }
    )
  );
  const selected = firstCraftVariant(options);
  assert.ok(selected);
  assert.equal(selected.ingredients.some((i) => i.name === "blackstone"), true);
});
