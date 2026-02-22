const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");

const { __test } = require("../brain/craft_executor");

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

function makePlacementBot({ solidTargets = new Set(), entities = {}, noSupport = false, placeError = null } = {}) {
  let placedPos = null;
  const placeCalls = [];
  const bot = {
    version: "1.21.1",
    entity: {
      id: 1,
      position: new Vec3(0, 64, 0),
      yaw: 0
    },
    entities,
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
    findBlock({ matching, maxDistance }) {
      if (typeof matching === "number" && placedPos) {
        if (bot.entity.position.distanceTo(placedPos) <= maxDistance) {
          return { position: placedPos, name: "crafting_table", boundingBox: "block" };
        }
      }
      return null;
    },
    blockAt(pos) {
      const p = pos.floored();
      if (placedPos && key(placedPos) === key(p)) {
        return { position: p, name: "crafting_table", boundingBox: "block" };
      }
      if (p.y === 63) {
        if (noSupport) return { position: p, name: "air", boundingBox: "empty" };
        return { position: p, name: "stone", boundingBox: "block" };
      }
      if (p.y === 64 && solidTargets.has(key(p))) {
        return { position: p, name: "stone", boundingBox: "block" };
      }
      return { position: p, name: "air", boundingBox: "empty" };
    },
    equip: async () => {},
    placeBlock: async (reference, face) => {
      const tablePos = reference.position.offset(face.x, face.y, face.z).floored();
      placeCalls.push(tablePos);
      if (placeError) throw new Error(placeError);
      placedPos = tablePos;
    },
    waitForTicks: async () => {}
  };

  return {
    bot,
    placeCalls,
    getPlacedPos: () => placedPos
  };
}

test("ensureTablePlaced uses alternative candidate when primary space is blocked", async () => {
  const ring4 = ringPositions(4);
  const solidTargets = new Set(ring4.map((p) => key(p)));
  const blockedTarget = new Vec3(4, 64, 0);
  const fallbackTarget = new Vec3(-4, 64, 0);
  solidTargets.delete(key(blockedTarget));
  solidTargets.delete(key(fallbackTarget));

  const entities = {
    2: { id: 2, type: "player", position: blockedTarget.offset(0, 0, 0) }
  };
  const { bot, getPlacedPos } = makePlacementBot({ solidTargets, entities });
  const events = [];
  const log = (evt) => events.push(evt);

  const result = await ensureTablePlaced(
    bot,
    {
      craftAutoPlaceTable: true,
      reasoningEnabled: true,
      reasoningPlacementRings: [4],
      reasoningMaxCorrectionsPerStep: 3,
      reasoningMoveTimeoutMs: 1000
    },
    { isCancelled: () => false },
    log
  );

  assert.equal(result.ok, true);
  assert.equal(key(getPlacedPos()), key(fallbackTarget));
  assert.equal(events.some((e) => e.type === "reasoner_candidate_pick"), true);
});

test("ensureTablePlaced fails explicitly when no valid local spot exists", async () => {
  const { bot } = makePlacementBot({ noSupport: true });
  const result = await ensureTablePlaced(
    bot,
    {
      craftAutoPlaceTable: true,
      reasoningEnabled: true,
      reasoningPlacementRings: [4, 8, 12],
      reasoningMaxCorrectionsPerStep: 2
    },
    { isCancelled: () => false },
    () => {}
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /failed to place crafting table/i);
  assert.match(result.nextNeed, /clear placement space/i);
});
