const test = require("node:test");
const assert = require("node:assert/strict");

const { planAndRun } = require("../brain/planner");

function makeBot() {
  return {
    pathfinder: {
      setGoal() {}
    },
    clearControlStates() {},
    chat() {}
  };
}

test("stopall sets state.stopped and returns success", async () => {
  const bot = makeBot();
  let state = { stopped: false };
  const out = await planAndRun(
    bot,
    { type: "stopall", source: "test", confidence: 1 },
    () => state,
    (next) => {
      state = next;
    },
    () => {},
    {},
    { id: 1, cancelled: false, isCancelled() { return this.cancelled; } }
  );

  assert.equal(out.status, "success");
  assert.equal(state.stopped, true);
});

test("stop does not set state.stopped", async () => {
  const bot = makeBot();
  let state = { stopped: false };
  const out = await planAndRun(
    bot,
    { type: "stop", source: "test", confidence: 1 },
    () => state,
    (next) => {
      state = next;
    },
    () => {},
    {},
    { id: 2, cancelled: false, isCancelled() { return this.cancelled; } }
  );

  assert.equal(out.status, "success");
  assert.equal(state.stopped, false);
});
