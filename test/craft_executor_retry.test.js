const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");

const { executeCraftPlan, __test } = require("../brain/craft_executor");

const { ensureTablePlaced } = __test;

function key(pos) {
  return `${pos.x},${pos.y},${pos.z}`;
}

function ringPositions(ring, y = 64) {
  const out = [];
  for (let i = -ring; i <= ring; i += 1) {
    out.push(new Vec3(i, y, -ring));
    out.push(new Vec3(i, y, ring));
    if (i !== -ring && i !== ring) {
      out.push(new Vec3(-ring, y, i));
      out.push(new Vec3(ring, y, i));
    }
  }
  return out;
}

function makeRetryBot({ placeBehavior } = {}) {
  let placedPos = null;
  const ring4 = ringPositions(4);
  const solidTargets = new Set(ring4.map((p) => key(p)));
  solidTargets.delete(key(new Vec3(-4, 64, 0)));
  const placeCalls = [];

  const bot = {
    version: "1.21.1",
    entity: {
      id: 1,
      position: new Vec3(0, 64, 0),
      yaw: 0
    },
    entities: {},
    inventory: {
      items: () => [{ name: "crafting_table", count: 1 }]
    },
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      }
    },
    findBlock({ matching }) {
      if (typeof matching === "number" && placedPos) {
        return { position: placedPos, name: "crafting_table", boundingBox: "block" };
      }
      return null;
    },
    blockAt(pos) {
      const p = pos.floored();
      if (placedPos && key(placedPos) === key(p)) {
        return { position: p, name: "crafting_table", boundingBox: "block" };
      }
      if (p.y === 63) return { position: p, name: "stone", boundingBox: "block" };
      if (p.y === 64 && solidTargets.has(key(p))) {
        return { position: p, name: "stone", boundingBox: "block" };
      }
      return { position: p, name: "air", boundingBox: "empty" };
    },
    equip: async () => {},
    placeBlock: async (reference, face) => {
      const tablePos = reference.position.offset(face.x, face.y, face.z).floored();
      placeCalls.push(tablePos);
      if (placeBehavior) {
        const result = placeBehavior(placeCalls.length, tablePos);
        if (result instanceof Error) throw result;
        if (result === false) throw new Error("occupied by entity");
      }
      placedPos = tablePos;
    },
    waitForTicks: async () => {}
  };

  return { bot, placeCalls };
}

test("recoverable placement failures trigger bounded retries", async () => {
  const { bot, placeCalls } = makeRetryBot({
    placeBehavior: () => false
  });

  const result = await ensureTablePlaced(
    bot,
    {
      craftAutoPlaceTable: true,
      reasoningEnabled: true,
      reasoningPlacementRings: [4],
      reasoningMaxCorrectionsPerStep: 2,
      reasoningMoveTimeoutMs: 1000
    },
    { isCancelled: () => false },
    () => {}
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /failed to place crafting table/i);
  assert.equal(placeCalls.length, 3);
});

test("cancellation interrupts self-correction retry loop", async () => {
  let cancelled = false;
  const { bot, placeCalls } = makeRetryBot({
    placeBehavior: () => {
      cancelled = true;
      return false;
    }
  });

  const runCtx = {
    isCancelled: () => cancelled
  };

  const result = await ensureTablePlaced(
    bot,
    {
      craftAutoPlaceTable: true,
      reasoningEnabled: true,
      reasoningPlacementRings: [4],
      reasoningMaxCorrectionsPerStep: 4,
      reasoningMoveTimeoutMs: 1000
    },
    runCtx,
    () => {}
  );

  assert.equal(result.status, "cancel");
  assert.equal(placeCalls.length, 1);
});

test("craft executor returns timeout when job deadline is exceeded", async () => {
  const bot = {
    version: "1.21.1",
    inventory: { items: () => [] },
    waitForTicks: async () => {}
  };
  const plan = {
    item: "stick",
    count: 1,
    timeoutSec: -1,
    steps: [{ action: "ensure_item", item: "stick", count: 1 }]
  };

  const result = await executeCraftPlan(
    bot,
    plan,
    {},
    { isCancelled: () => false },
    () => {}
  );
  assert.equal(result.status, "timeout");
});
