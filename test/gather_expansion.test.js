const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");

const { executeGoalPlan } = require("../brain/craft_executor");

function makeRunCtx() {
  return {
    id: 301,
    cancelled: false,
    isCancelled() {
      return this.cancelled;
    },
    setStep() {},
    reportProgress() {}
  };
}

test("gather expansion checks rings 24 -> 48 and succeeds on later ring", async () => {
  const seenRadius = [];
  const inv = [];
  const targetPos = new Vec3(10, 64, 10);

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv },
    findBlocks({ matching, maxDistance }) {
      seenRadius.push(maxDistance);
      const sample = { name: "oak_log", position: targetPos };
      if (maxDistance >= 48 && matching(sample)) return [targetPos];
      return [];
    },
    blockAt(pos) {
      if (pos && pos.x === targetPos.x && pos.y === targetPos.y && pos.z === targetPos.z) {
        return { name: "oak_log", position: targetPos, boundingBox: "block" };
      }
      if (pos && pos.y === 63) {
        return { name: "stone", position: new Vec3(pos.x, pos.y, pos.z), boundingBox: "block" };
      }
      return { name: "air", position: pos || new Vec3(0, 0, 0), boundingBox: "empty" };
    },
    dig: async () => {
      inv.push({ name: "oak_log", count: 1 });
    },
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      }
    },
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_gather_expand",
    item: "oak_log",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_gather_expand_s1",
        action: "gather_block",
        args: { item: "oak_log", count: 1, blockNames: ["oak_log"] },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      gatherRadiusSteps: [24, 48, 72],
      gatherExpandRetryPerRing: 1,
      gatherStepTimeoutSec: 1000,
      reasoningEnabled: false
    },
    makeRunCtx(),
    () => {}
  );

  assert.equal(result.status, "success");
  assert.equal(seenRadius.includes(24), true);
  assert.equal(seenRadius.includes(48), true);
});

test("gather expansion requests confirmation after max ring miss", async () => {
  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    findBlocks: () => [],
    blockAt: () => null,
    pathfinder: { setGoal() {} },
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_gather_miss",
    item: "oak_log",
    count: 1,
    constraints: { timeoutSec: 10 },
    steps: [
      {
        id: "goal_gather_miss_s1",
        action: "gather_block",
        args: { item: "oak_log", count: 1, blockNames: ["oak_log"] },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      gatherRadiusSteps: [24, 48, 72],
      gatherExpandRetryPerRing: 1,
      gatherStepTimeoutSec: 1000,
      missingResourcePolicy: "ask_before_move",
      missingResourceExpandedRadius: 120
    },
    makeRunCtx(),
    () => {}
  );

  assert.equal(result.status, "fail");
  assert.equal(result.code, "confirm_expand_search");
  assert.equal(result.meta.item, "oak_log");
  assert.equal(result.meta.fromRadius, 72);
  assert.equal(result.meta.toRadius, 120);
  assert.match(result.reason, /within 72/i);
});

test("gather uses local block scan when findBlocks misses nearby block", async () => {
  const inv = [];
  const targetPos = new Vec3(1, 64, 0);
  let findBlocksCalls = 0;

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv },
    findBlocks() {
      findBlocksCalls += 1;
      return [];
    },
    blockAt(pos) {
      if (!pos) return null;
      const p = new Vec3(pos.x, pos.y, pos.z);
      if (p.x === targetPos.x && p.y === targetPos.y && p.z === targetPos.z) {
        return { name: "oak_log", position: p, boundingBox: "block" };
      }
      if (p.y === 63) {
        return { name: "stone", position: p, boundingBox: "block" };
      }
      return { name: "air", position: p, boundingBox: "empty" };
    },
    dig: async () => {
      inv.push({ name: "oak_log", count: 1 });
    },
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      }
    },
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_local_scan",
    item: "oak_log",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_local_scan_s1",
        action: "gather_block",
        args: { item: "oak_log", count: 1, blockNames: ["oak_log"] },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      gatherRadiusSteps: [24],
      gatherExpandRetryPerRing: 1,
      gatherStepTimeoutSec: 1000,
      reasoningEnabled: false
    },
    makeRunCtx(),
    () => {}
  );

  assert.equal(findBlocksCalls > 0, true);
  assert.equal(result.status, "success");
});
