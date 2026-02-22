const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");

const {
  findPlacementCandidate,
  scoreCandidate
} = require("../brain/local_reasoner");

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

function makeBot({ blockedTargets = new Set(), entities = {} } = {}) {
  return {
    entity: {
      id: 1,
      position: new Vec3(0, 64, 0),
      yaw: 0
    },
    entities,
    blockAt(pos) {
      const p = pos.floored();
      if (p.y === 63) return { position: p, name: "stone", boundingBox: "block" };
      if (p.y === 64 && blockedTargets.has(key(p))) {
        return { position: p, name: "stone", boundingBox: "block" };
      }
      return { position: p, name: "air", boundingBox: "empty" };
    }
  };
}

test("findPlacementCandidate prefers first ring (4 -> 8 -> 12)", () => {
  const bot = makeBot();
  const candidate = findPlacementCandidate(bot, {
    cfg: { reasoningPlacementRings: [4, 8, 12] }
  });
  assert.ok(candidate);
  assert.equal(candidate.ring, 4);
});

test("findPlacementCandidate rejects occupied target cell", () => {
  const ring4 = ringPositions(4);
  const blockedTargets = new Set(ring4.map((p) => key(p)));
  const allowedOpenA = new Vec3(4, 64, 0);
  const allowedOpenB = new Vec3(-4, 64, 0);
  blockedTargets.delete(key(allowedOpenA));
  blockedTargets.delete(key(allowedOpenB));

  const entities = {
    2: {
      id: 2,
      type: "player",
      position: allowedOpenA.offset(0, 0, 0)
    }
  };

  const bot = makeBot({ blockedTargets, entities });
  const candidate = findPlacementCandidate(bot, {
    cfg: { reasoningPlacementRings: [4] }
  });

  assert.ok(candidate);
  assert.equal(key(candidate.tablePos), key(allowedOpenB));
});

test("scoreCandidate penalizes blocked placements over clear options", () => {
  const bot = makeBot();
  const blockedNear = {
    ring: 4,
    center: new Vec3(0.5, 64, -3.5),
    blockedByEntity: true
  };
  const clearFar = {
    ring: 8,
    center: new Vec3(0.5, 64, -7.5),
    blockedByEntity: false
  };

  const blockedScore = scoreCandidate(blockedNear, { bot });
  const clearScore = scoreCandidate(clearFar, { bot });
  assert.ok(blockedScore > clearScore);
});
