const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildRecipeDb, getRecipeVariants, getStationForVariant } = require("../brain/recipe_db");

test("recipe_db loads deterministic variants for known items", () => {
  const db = buildRecipeDb("1.21.1");
  assert.ok(db.entriesByOutput.size > 0);
  const variants = getRecipeVariants("stone_sword", { version: "1.21.1" });
  assert.ok(variants.length > 0);
  assert.equal(variants.every((v) => Array.isArray(v.ingredients) && v.ingredients.length > 0), true);
});

test("recipe_db includes smelt station recipes", () => {
  const variants = getRecipeVariants("glass", { version: "1.21.1" });
  const smelt = variants.find((v) => v.processType === "smelt");
  assert.ok(smelt);
  assert.equal(smelt.station, "furnace");
});

test("getStationForVariant resolves stored station", () => {
  const variants = getRecipeVariants("stone_sword", { version: "1.21.1" });
  const variant = variants[0];
  assert.ok(variant);
  const station = getStationForVariant(variant.variantId, { version: "1.21.1" });
  assert.equal(typeof station, "string");
  assert.equal(station.length > 0, true);
});

test("overworld_v1 loads manifest-backed smelt variants", () => {
  const variants = getRecipeVariants("iron_ingot", {
    version: "1.21.1",
    craftCoverageMode: "overworld_v1",
    craftRecipeManifestVersion: "1.21.1-overworld-v1"
  });
  const smelt = variants.find((v) => v.processType === "smelt" && v.station === "furnace");
  assert.ok(smelt);
  assert.equal(smelt.ingredients.some((ing) => ing.name === "raw_iron"), true);
});

test("overworld_v1 rejects invalid manifest row deterministically", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-ai-bot-recipe-db-"));
  const manifestPath = path.join(tmpDir, "bad_manifest.json");
  try {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        version: "1.21.1-overworld-v1",
        entries: [
          {
            outputItem: "not_a_real_item",
            outputCount: 1,
            processType: "smelt",
            station: "furnace",
            ingredients: [{ name: "raw_iron", count: 1 }],
            variantId: "bad:entry",
            scope: "overworld"
          }
        ]
      }),
      "utf8"
    );

    const events = [];
    assert.throws(() => {
      buildRecipeDb("1.21.1", {
        craftCoverageMode: "overworld_v1",
        craftRecipeManifestVersion: "1.21.1-overworld-v1",
        manifestPath,
        log: (evt) => events.push(evt)
      });
    });
    assert.equal(events.some((e) => e.type === "recipe_manifest_reject"), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("legacy mode keeps static smithing variants", () => {
  const variants = getRecipeVariants("netherite_sword", {
    version: "1.21.1",
    craftCoverageMode: "legacy"
  });
  assert.equal(variants.some((v) => v.processType === "smithing" && v.station === "smithing_table"), true);
});
