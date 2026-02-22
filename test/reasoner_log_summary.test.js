const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");

const { findRepositionCandidate } = require("../brain/local_reasoner");

function makeBot(cannotStand = true) {
  return {
    entity: {
      id: 1,
      position: new Vec3(0, 64, 0),
      yaw: 0
    },
    entities: {},
    blockAt(pos) {
      const p = pos.floored();
      if (p.y === 63) {
        return cannotStand
          ? { position: p, name: "air", boundingBox: "empty" }
          : { position: p, name: "stone", boundingBox: "block" };
      }
      return { position: p, name: "air", boundingBox: "empty" };
    }
  };
}

test("reject summary is emitted when detailed reject logs are disabled", () => {
  const events = [];
  const bot = makeBot(true);
  findRepositionCandidate(bot, {
    cfg: {
      reasoningPlacementRings: [4],
      logReasonerCandidateRejects: false,
      logReasonerRejectSummaryEverySec: 0.001
    },
    log: (evt) => events.push(evt)
  });

  assert.equal(events.some((e) => e.type === "reasoner_reject_summary"), true);
});

test("detailed reject logs are emitted when enabled", () => {
  const events = [];
  const bot = makeBot(true);
  findRepositionCandidate(bot, {
    cfg: {
      reasoningPlacementRings: [4],
      logReasonerCandidateRejects: true,
      logReasonerRejectSummaryEverySec: 5
    },
    log: (evt) => events.push(evt)
  });

  assert.equal(events.some((e) => e.type === "reasoner_candidate_reject"), true);
});

