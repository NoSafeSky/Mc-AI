const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");

const { shouldRetreat, executeCombatTurn } = require("../brain/combat_controller");

test("shouldRetreat triggers on low health and food", () => {
  const hp = shouldRetreat({ health: 6, food: 20 }, { combatRetreatHealth: 8, combatRetreatFood: 8 });
  const food = shouldRetreat({ health: 20, food: 6 }, { combatRetreatHealth: 8, combatRetreatFood: 8 });
  assert.equal(hp.retreat, true);
  assert.equal(food.retreat, true);
});

test("executeCombatTurn returns retreat failure when unsafe", async () => {
  const bot = {
    health: 5,
    food: 20,
    entity: { position: new Vec3(0, 64, 0) },
    waitForTicks: async () => {}
  };
  const out = await executeCombatTurn(
    bot,
    { position: new Vec3(1, 64, 0), isValid: true },
    { combatRetreatHealth: 8, combatRetreatFood: 8 },
    { isCancelled: () => false },
    () => {}
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, "combat_retreat");
});

test("executeCombatTurn attacks reachable target", async () => {
  let attacked = 0;
  const bot = {
    health: 20,
    food: 20,
    entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
    attack: () => { attacked += 1; },
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      },
      setMovements() {}
    },
    waitForTicks: async () => {}
  };
  const out = await executeCombatTurn(
    bot,
    { position: new Vec3(1, 64, 0), isValid: true },
    { movementProfile: "human_cautious", combatUsePvpPlugin: false },
    { isCancelled: () => false },
    () => {}
  );
  assert.equal(out.ok, true);
  assert.equal(attacked > 0, true);
});
