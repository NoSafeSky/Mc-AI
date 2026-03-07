const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");

const { moveNearHuman, __test } = require("../brain/motion_controller");

test("humanLikeEnabled true for human_cautious profile", () => {
  assert.equal(__test.humanLikeEnabled({ movementProfile: "human_cautious" }), true);
  assert.equal(__test.humanLikeEnabled({ movementProfile: "default" }), false);
});

test("moveNearHuman returns success when path goal reaches target", async () => {
  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
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

  const result = await moveNearHuman(
    bot,
    new Vec3(5, 64, 0),
    2,
    1000,
    { isCancelled: () => false },
    { movementProfile: "human_cautious" },
    () => {},
    "test_move"
  );

  assert.equal(result.status, "success");
});

test("moveNearHuman returns path_blocked on no-progress even when timeouts disabled", async () => {
  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
    pathfinder: {
      setGoal() {},
      setMovements() {}
    },
    waitForTicks: async () => {}
  };

  const result = await moveNearHuman(
    bot,
    new Vec3(5, 64, 0),
    1,
    1000,
    { isCancelled: () => false },
    { disableTimeouts: true, movementNoProgressTimeoutMs: 60, movementProfile: "default" },
    () => {},
    "test_stall"
  );

  assert.equal(result.status, "timeout");
  assert.equal(result.code, "path_blocked");
  assert.equal(String(result.reason || "").includes("path stalled"), true);
});
