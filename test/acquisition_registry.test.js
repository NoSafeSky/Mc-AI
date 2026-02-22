const test = require("node:test");
const assert = require("node:assert/strict");

const {
  chooseAcquisitionOption,
  getAcquisitionOptions
} = require("../brain/acquisition_registry");

function makeCtx(extra = {}) {
  return {
    mcData: require("minecraft-data")("1.21.1"),
    cfg: {
      autoGatherEnabled: true,
      supportedStations: ["inventory", "crafting_table", "furnace"]
    },
    snapshot: { inventory: {} },
    bot: { entities: {} },
    ...extra
  };
}

test("from_inventory is selected when enough items already exist", () => {
  const option = chooseAcquisitionOption("stick", 1, makeCtx({
    snapshot: { inventory: { stick: 3 } }
  }));
  assert.equal(option.provider, "from_inventory");
});

test("glass selects smelt route with furnace station", () => {
  const option = chooseAcquisitionOption("glass", 1, makeCtx());
  assert.equal(option.provider, "smelt_recipe");
  assert.equal(option.station, "furnace");
  assert.equal(option.input, "sand");
});

test("unknown ingredient returns unsupported_source", () => {
  const option = chooseAcquisitionOption("definitely_not_an_item", 1, makeCtx());
  assert.equal(option.provider, "unsupported_source");
});

test("mob-drop route is available for porkchop when pig exists", () => {
  const options = getAcquisitionOptions("porkchop", 1, makeCtx({
    bot: { entities: { a: { name: "pig" } } }
  }));
  assert.equal(options.some((o) => o.provider === "kill_mob_drop"), true);
});

test("autoGatherEnabled false disables gather/harvest/kill providers", () => {
  const options = getAcquisitionOptions("porkchop", 1, makeCtx({
    cfg: {
      autoGatherEnabled: false,
      supportedStations: ["inventory", "crafting_table", "furnace"]
    }
  }));
  assert.equal(options.some((o) => o.provider === "kill_mob_drop"), false);
});
