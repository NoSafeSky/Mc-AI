const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");

const {
  isLivingNonPlayerEntity,
  matchesTargetNameStrict
} = require("../brain/entities");

function makeEntity({ type, name = "unknown", x = 0, y = 0, z = 0 }) {
  return {
    type,
    name,
    position: new Vec3(x, y, z)
  };
}

test("living entity classification includes animal/hostile/mob", () => {
  assert.equal(isLivingNonPlayerEntity(makeEntity({ type: "animal", name: "pig" })), true);
  assert.equal(isLivingNonPlayerEntity(makeEntity({ type: "hostile", name: "zombie" })), true);
  assert.equal(isLivingNonPlayerEntity(makeEntity({ type: "mob", name: "allay" })), true);
});

test("living entity classification excludes player/projectile/other", () => {
  assert.equal(isLivingNonPlayerEntity(makeEntity({ type: "player", name: "player" })), false);
  assert.equal(isLivingNonPlayerEntity(makeEntity({ type: "projectile", name: "arrow" })), false);
  assert.equal(isLivingNonPlayerEntity(makeEntity({ type: "other", name: "unknown" })), false);
});

test("strict name matching exact and alias only", () => {
  const aliases = new Map([["piggy", "pig"]]);
  assert.equal(matchesTargetNameStrict("pig", "pig", aliases), true);
  assert.equal(matchesTargetNameStrict("pig", "piggy", aliases), true);
  assert.equal(matchesTargetNameStrict("piglin", "pig", aliases), false);
  assert.equal(matchesTargetNameStrict("", "pig", aliases), false);
});
