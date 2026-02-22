const test = require("node:test");
const assert = require("node:assert/strict");

const { TaskSupervisor } = require("../brain/task_supervisor");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("no-progress triggers task_stall_fail and cancellation", async () => {
  const events = [];
  const runCtx = { id: 101, cancelled: false };
  let goalCleared = false;
  let controlsCleared = false;
  const bot = {
    pathfinder: {
      setGoal(goal) {
        if (goal == null) goalCleared = true;
      }
    },
    clearControlStates() {
      controlsCleared = true;
    }
  };

  const supervisor = new TaskSupervisor({
    bot,
    runCtx,
    cfg: {
      taskNoProgressTimeoutSec: 0.05,
      taskProgressHeartbeatSec: 0.01
    },
    log: (evt) => events.push(evt),
    intentType: "craftItem",
    goalId: "goal_test"
  });

  await sleep(120);
  supervisor.finish("fail");

  assert.equal(runCtx.cancelled, true);
  assert.ok(runCtx.stallResult);
  assert.equal(runCtx.stallResult.code, "task_stalled");
  assert.equal(goalCleared, true);
  assert.equal(controlsCleared, true);
  assert.equal(events.some((e) => e.type === "task_stall_fail"), true);
});

test("regular progress updates prevent stall timeout", async () => {
  const events = [];
  const runCtx = { id: 102, cancelled: false };
  const supervisor = new TaskSupervisor({
    bot: {},
    runCtx,
    cfg: {
      taskNoProgressTimeoutSec: 0.1,
      taskProgressHeartbeatSec: 0.02
    },
    log: (evt) => events.push(evt),
    intentType: "explore"
  });

  for (let i = 0; i < 4; i += 1) {
    supervisor.reportProgress("still running", { attempt: i + 1 });
    await sleep(40);
  }

  supervisor.finish("success");
  assert.equal(runCtx.cancelled, false);
  assert.equal(events.some((e) => e.type === "task_stall_fail"), false);
  assert.equal(events.some((e) => e.type === "task_progress"), true);
});

test("finish is idempotent and keeps first terminal status", () => {
  const supervisor = new TaskSupervisor({
    bot: {},
    runCtx: { id: 103, cancelled: false },
    cfg: {},
    log: () => {},
    intentType: "attackMob"
  });

  supervisor.finish("success");
  supervisor.finish("fail", { code: "unexpected", reason: "unexpected" });
  const state = supervisor.getState();
  assert.equal(state.status, "success");
});

