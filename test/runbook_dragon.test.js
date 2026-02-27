const test = require("node:test");
const assert = require("node:assert/strict");

const {
  phaseNeeds,
  isPhaseComplete,
  nextPhase,
  proposePhaseRecommendation
} = require("../brain/runbook_dragon");

test("bootstrap phase reports missing wooden pickaxe from empty inventory", () => {
  const missing = phaseNeeds("bootstrap", { inventory: {} });
  assert.equal(missing.some((m) => m.item === "wooden_pickaxe"), true);
});

test("stone age phase is complete when required tools exist", () => {
  const complete = isPhaseComplete("stone_age", {
    inventory: {
      stone_pickaxe: 1,
      stone_sword: 1,
      furnace: 1
    }
  });
  assert.equal(complete, true);
});

test("nextPhase advances in fixed order", () => {
  assert.equal(nextPhase("bootstrap"), "stone_age");
  assert.equal(nextPhase("end_prep"), "dragon_fight");
});

test("blaze phase recommends attackMob blaze when rods missing", () => {
  const rec = proposePhaseRecommendation("blaze_phase", { inventory: {} }, {});
  assert.ok(rec);
  assert.equal(rec.intent.type, "attackMob");
  assert.equal(rec.intent.mobType, "blaze");
});
