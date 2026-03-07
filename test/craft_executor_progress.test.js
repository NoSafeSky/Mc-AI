const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");

const { executeGoalPlan } = require("../brain/craft_executor");

test("executeGoalPlan emits step progress and terminal logs", async () => {
  const events = [];
  const progress = [];
  const runCtx = {
    id: 201,
    cancelled: false,
    isCancelled() {
      return this.cancelled;
    },
    setStep() {},
    reportProgress(msg, extra) {
      progress.push({ msg, extra });
    }
  };

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_progress",
    item: "stick",
    count: 0,
    constraints: { timeoutSec: 5 },
    steps: [
      {
        id: "goal_progress_s1",
        action: "ensure_station",
        args: { station: "inventory" },
        retryPolicy: {},
        timeoutMs: 500
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {},
    runCtx,
    (evt) => events.push(evt),
    (msg, extra) => progress.push({ msg, extra })
  );

  assert.equal(result.status, "success");
  assert.equal(events.some((e) => e.type === "step_progress"), true);
  assert.equal(events.some((e) => e.type === "step_terminal" && e.status === "success"), true);
  assert.equal(progress.some((p) => String(p.msg).includes("step ensure_station")), true);
});

test("step timeout returns explicit step_timeout failure", async () => {
  const events = [];
  const runCtx = {
    id: 202,
    cancelled: false,
    isCancelled() {
      return this.cancelled;
    },
    setStep() {},
    reportProgress() {}
  };

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    findBlocks: () => [],
    blockAt: () => null,
    pathfinder: { setGoal() {} },
    waitForTicks: async () => new Promise(() => {})
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_timeout",
    item: "oak_log",
    count: 1,
    constraints: { timeoutSec: 5 },
    steps: [
      {
        id: "goal_timeout_s1",
        action: "gather_block",
        args: { item: "oak_log", count: 1, blockNames: ["oak_log"] },
        retryPolicy: {},
        timeoutMs: 50
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      gatherRadiusSteps: [24],
      gatherExpandRetryPerRing: 1,
      gatherStepTimeoutSec: 50
    },
    runCtx,
    (evt) => events.push(evt)
  );

  assert.equal(result.status, "fail");
  assert.equal(result.code, "step_timeout");
  assert.equal(events.some((e) => e.type === "step_timeout"), true);
  assert.equal(events.some((e) => e.type === "step_terminal" && e.status === "fail"), true);
});

test("stall guard retries and fails explicitly when step hangs with timeouts disabled", async () => {
  const events = [];
  const runCtx = {
    id: 203,
    cancelled: false,
    isCancelled() {
      return this.cancelled;
    },
    setStep() {},
    reportProgress() {}
  };

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    findBlocks: () => [],
    blockAt: () => null,
    pathfinder: { setGoal() {} },
    clearControlStates() {},
    waitForTicks: async () => new Promise(() => {})
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_stall_guard",
    item: "oak_log",
    count: 1,
    constraints: { timeoutSec: 5 },
    steps: [
      {
        id: "goal_stall_guard_s1",
        action: "gather_block",
        args: { item: "oak_log", count: 1, blockNames: ["oak_log"] },
        retryPolicy: {},
        timeoutMs: 50
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      disableTimeouts: true,
      stepStallGuardMs: 120,
      stepStallRetryCount: 1,
      gatherRadiusSteps: [24],
      gatherExpandRetryPerRing: 1
    },
    runCtx,
    (evt) => events.push(evt)
  );

  assert.equal(result.status, "fail");
  assert.equal(result.code, "step_stalled");
  assert.equal(events.some((e) => e.type === "step_stall"), true);
  assert.equal(events.some((e) => e.type === "step_retry" && e.reason === "step_stalled"), true);
  assert.equal(events.some((e) => e.type === "step_terminal" && e.status === "fail"), true);
});
