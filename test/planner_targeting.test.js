const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");

const { __test } = require("../brain/planner");

function makeEntity(id, type, name, x, y, z) {
  return {
    id,
    type,
    name,
    position: new Vec3(x, y, z)
  };
}

function makeBot(entities) {
  return {
    entity: { position: new Vec3(0, 0, 0) },
    entities
  };
}

test("findNearestTargetByName selects pig and not piglin", () => {
  const bot = makeBot({
    a: makeEntity(1, "animal", "piglin", 1, 0, 0),
    b: makeEntity(2, "animal", "pig", 2, 0, 0)
  });
  const target = __test.findNearestTargetByName(bot, "pig", 32, __test.TARGET_NAME_ALIASES);
  assert.ok(target);
  assert.equal(target.name, "pig");
});

test("chooseNearestLivingEntity ignores non-living types", () => {
  const bot = makeBot({
    a: makeEntity(1, "projectile", "arrow", 1, 0, 0),
    b: makeEntity(2, "player", "player", 1, 0, 0),
    c: makeEntity(3, "animal", "cow", 3, 0, 0)
  });
  const target = __test.chooseNearestLivingEntity(bot, (name) => name === "cow", 32);
  assert.ok(target);
  assert.equal(target.name, "cow");
});

test("nearbyLivingDiagnostics lists only living entities in range", () => {
  const bot = makeBot({
    a: makeEntity(1, "animal", "pig", 2, 0, 0),
    b: makeEntity(2, "hostile", "zombie", 3, 0, 0),
    c: makeEntity(3, "projectile", "arrow", 1, 0, 0),
    d: makeEntity(4, "animal", "cow", 100, 0, 0)
  });
  const diag = __test.nearbyLivingDiagnostics(bot, 10, 10);
  assert.equal(diag.some((x) => x.startsWith("pig:animal@")), true);
  assert.equal(diag.some((x) => x.startsWith("zombie:hostile@")), true);
  assert.equal(diag.some((x) => x.startsWith("arrow:projectile@")), false);
  assert.equal(diag.some((x) => x.startsWith("cow:animal@")), false);
});
