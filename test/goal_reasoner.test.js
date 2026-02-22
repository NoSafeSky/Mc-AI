const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");

const {
  runStepWithCorrection,
  runGoalWithReplan
} = require("../brain/goal_reasoner");

function makeBot() {
  const bot = {
    entity: {
      id: 1,
      position: new Vec3(0, 64, 0),
      yaw: 0
    },
    entities: {},
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      }
    },
    blockAt(pos) {
      const p = pos.floored();
      if (p.y === 63) return { position: p, name: "stone", boundingBox: "block" };
      return { position: p, name: "air", boundingBox: "empty" };
    },
    waitForTicks: async () => {}
  };
  return bot;
}

test("runStepWithCorrection recovers on recoverable error and retries", async () => {
  const events = [];
  const bot = makeBot();
  let calls = 0;

  const result = await runStepWithCorrection(
    "test_step",
    async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          code: "path_blocked",
          reason: "path blocked",
          recoverable: true
        };
      }
      return { ok: true };
    },
    {
      bot,
      cfg: {
        reasoningPlacementRings: [4],
        reasoningMoveTimeoutMs: 1000
      },
      runCtx: { isCancelled: () => false },
      log: (evt) => events.push(evt)
    },
    { maxCorrections: 2 }
  );

  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(events.some((e) => e.type === "reasoner_step_recover"), true);
});

test("runGoalWithReplan rebuilds plan on recoverable failure", async () => {
  const events = [];
  let execCount = 0;
  let rebuildCount = 0;

  const result = await runGoalWithReplan({
    initialGoal: { ok: true, goalId: "goal_a" },
    executeGoal: async () => {
      execCount += 1;
      if (execCount === 1) {
        return {
          ok: false,
          code: "path_blocked",
          reason: "path blocked",
          recoverable: true
        };
      }
      return { ok: true };
    },
    rebuildGoal: async () => {
      rebuildCount += 1;
      return { ok: true, goalId: `goal_rebuilt_${rebuildCount}` };
    },
    cfg: {
      replanOnRecoverableFail: true,
      maxReplansPerGoal: 2
    },
    runCtx: { isCancelled: () => false },
    log: (evt) => events.push(evt)
  });

  assert.equal(result.ok, true);
  assert.equal(execCount, 2);
  assert.equal(rebuildCount, 1);
  assert.equal(events.some((e) => e.type === "step_replan"), true);
});

test("runGoalWithReplan stops immediately when cancelled", async () => {
  const result = await runGoalWithReplan({
    initialGoal: { ok: true, goalId: "goal_cancel" },
    executeGoal: async () => ({ ok: true }),
    cfg: { maxReplansPerGoal: 2 },
    runCtx: { isCancelled: () => true },
    log: () => {}
  });

  assert.equal(result.status, "cancel");
  assert.equal(result.code, "cancelled");
});
