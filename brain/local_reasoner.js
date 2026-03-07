const { goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");

function toNumberArray(value, fallback) {
  if (Array.isArray(value)) {
    const nums = value
      .map((n) => Number.parseInt(n, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (nums.length) return nums;
  }
  return fallback;
}

function timeoutsDisabled(cfg = {}) {
  return cfg?.disableTimeouts === true;
}

function getPolicy(cfg = {}, policy = {}) {
  return {
    rings: toNumberArray(policy.rings || cfg.reasoningPlacementRings, [4, 8, 12]),
    maxCorrections: Number.isFinite(policy.maxCorrections)
      ? policy.maxCorrections
      : (cfg.reasoningMaxCorrectionsPerStep || 6),
    candidateLimit: Number.isFinite(policy.candidateLimit)
      ? policy.candidateLimit
      : (cfg.reasoningCandidateLimit || 24),
    clearance: Number.isFinite(policy.clearance)
      ? policy.clearance
      : (cfg.reasoningEntityClearance || 1.2),
    moveTimeoutMs: Number.isFinite(policy.moveTimeoutMs)
      ? policy.moveTimeoutMs
      : (cfg.reasoningMoveTimeoutMs || 12000)
  };
}

function shouldLogCandidateReject(options = {}) {
  return !!options?.cfg?.logReasonerCandidateRejects;
}

const rejectSummaryState = {
  lastEmitAt: 0,
  counts: new Map()
};

function pushRejectSummary(options, evt) {
  const intervalSec = Number(options?.cfg?.logReasonerRejectSummaryEverySec || 0);
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) return;
  const log = options.log;
  if (typeof log !== "function") return;

  const key = `${evt.where}:${evt.reason}`;
  const current = rejectSummaryState.counts.get(key) || 0;
  rejectSummaryState.counts.set(key, current + 1);

  const now = Date.now();
  if (now - rejectSummaryState.lastEmitAt < intervalSec * 1000) return;
  rejectSummaryState.lastEmitAt = now;

  const buckets = Array.from(rejectSummaryState.counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, count]) => ({ key: k, count }));
  const total = Array.from(rejectSummaryState.counts.values()).reduce((a, b) => a + b, 0);
  rejectSummaryState.counts.clear();

  log({
    type: "reasoner_reject_summary",
    total,
    buckets
  });
}

function logCandidateReject(options, evt) {
  if (shouldLogCandidateReject(options)) {
    const log = options.log;
    if (typeof log === "function") log(evt);
    return;
  }
  pushRejectSummary(options, evt);
}

function isSolid(block) {
  return !!block && block.boundingBox === "block";
}

function isEmpty(block) {
  return !block || block.boundingBox === "empty";
}

function entityDistanceXZ(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function isEntityBlocking(bot, pos, clearance = 1.2) {
  const entities = Object.values(bot.entities || {});
  for (const e of entities) {
    if (!e?.position || e.id === bot.entity?.id) continue;
    const dy = Math.abs((e.position.y || 0) - pos.y);
    if (dy > 1.6) continue;
    const dist = entityDistanceXZ(e.position, pos);
    if (dist <= clearance) return true;
  }
  return false;
}

function getLookVector(bot) {
  const yaw = bot.entity?.yaw || 0;
  return new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw)).normalize();
}

function canStandAt(bot, standPos, options = {}) {
  const clearance = options.clearance || 1.2;
  const below = bot.blockAt(standPos.offset(0, -1, 0));
  const feet = bot.blockAt(standPos);
  const head = bot.blockAt(standPos.offset(0, 1, 0));
  if (!isSolid(below)) return false;
  if (!isEmpty(feet) || !isEmpty(head)) return false;
  if (isEntityBlocking(bot, standPos, clearance)) return false;
  return true;
}

function isPlacementFaceClear(bot, referenceBlock, faceVec, options = {}) {
  if (!referenceBlock || !referenceBlock.position) return false;
  const targetPos = referenceBlock.position.offset(faceVec.x, faceVec.y, faceVec.z);
  const target = bot.blockAt(targetPos);
  if (!isEmpty(target)) return false;
  if (isEntityBlocking(bot, targetPos, options.clearance || 1.2)) return false;
  return true;
}

function scoreCandidate(candidate, context = {}) {
  const bot = context.bot;
  if (!bot) return Number.POSITIVE_INFINITY;
  const look = getLookVector(bot);
  const vec = candidate.center.minus(bot.entity.position);
  const horizontal = new Vec3(vec.x, 0, vec.z);
  const dist = Math.sqrt(horizontal.x * horizontal.x + horizontal.z * horizontal.z);
  const dir = dist > 0.0001 ? horizontal.normalize() : new Vec3(0, 0, 0);
  const forward = dist > 0.0001 ? look.dot(dir) : 0;
  const ringPenalty = candidate.ring * 10;
  const distPenalty = dist * 2;
  const forwardBonus = forward * 2;
  const clearancePenalty = candidate.blockedByEntity ? 100 : 0;
  const crampedPenalty = Number(candidate.cramped || 0) * 8;
  const underBotPenalty = candidate.underBot ? 120 : 0;
  const insideBotPenalty = candidate.insideBot ? 200 : 0;
  return ringPenalty + distPenalty + clearancePenalty + crampedPenalty + underBotPenalty + insideBotPenalty - forwardBonus;
}

function ringOffsets(ring) {
  const offsets = [];
  for (let i = -ring; i <= ring; i++) {
    offsets.push({ dx: i, dz: -ring, ring });
    offsets.push({ dx: i, dz: ring, ring });
    if (i !== -ring && i !== ring) {
      offsets.push({ dx: -ring, dz: i, ring });
      offsets.push({ dx: ring, dz: i, ring });
    }
  }
  return offsets;
}

function candidateStandSpots(targetPos) {
  return [
    targetPos.offset(1, 0, 0),
    targetPos.offset(-1, 0, 0),
    targetPos.offset(0, 0, 1),
    targetPos.offset(0, 0, -1),
    targetPos.offset(1, 0, 1),
    targetPos.offset(-1, 0, 1),
    targetPos.offset(1, 0, -1),
    targetPos.offset(-1, 0, -1)
  ].map((p) => p.floored());
}

function countSolidNeighbors(bot, pos) {
  const dirs = [
    { x: 1, z: 0 },
    { x: -1, z: 0 },
    { x: 0, z: 1 },
    { x: 0, z: -1 }
  ];
  let solid = 0;
  for (const d of dirs) {
    const b = bot.blockAt(pos.offset(d.x, 0, d.z));
    if (isSolid(b)) solid += 1;
  }
  return solid;
}

function isSameBlock(a, b) {
  if (!a || !b) return false;
  const af = a.floored();
  const bf = b.floored();
  return af.x === bf.x && af.y === bf.y && af.z === bf.z;
}

function findPlacementCandidate(bot, options = {}) {
  const policy = getPolicy(options.cfg || {}, options);
  const center = bot.entity.position.floored();
  const candidates = [];

  for (const ring of policy.rings) {
    for (const off of ringOffsets(ring)) {
      const tablePos = center.offset(off.dx, 0, off.dz).floored();
      const support = bot.blockAt(tablePos.offset(0, -1, 0));
      const atTarget = bot.blockAt(tablePos);
      const head = bot.blockAt(tablePos.offset(0, 1, 0));

      if (!isSolid(support)) {
        logCandidateReject(options, { type: "reasoner_candidate_reject", where: "findPlacementCandidate", ring, reason: "no_support", x: tablePos.x, y: tablePos.y, z: tablePos.z });
        continue;
      }
      if (!isEmpty(atTarget) || !isEmpty(head)) {
        logCandidateReject(options, { type: "reasoner_candidate_reject", where: "findPlacementCandidate", ring, reason: "occupied_cell", x: tablePos.x, y: tablePos.y, z: tablePos.z });
        continue;
      }
      if (!isPlacementFaceClear(bot, support, { x: 0, y: 1, z: 0 }, policy)) {
        logCandidateReject(options, { type: "reasoner_candidate_reject", where: "findPlacementCandidate", ring, reason: "face_not_clear", x: tablePos.x, y: tablePos.y, z: tablePos.z });
        continue;
      }

      const stand = candidateStandSpots(tablePos).find((s) => canStandAt(bot, s, policy));
      if (!stand) {
        logCandidateReject(options, { type: "reasoner_candidate_reject", where: "findPlacementCandidate", ring, reason: "no_stand_spot", x: tablePos.x, y: tablePos.y, z: tablePos.z });
        continue;
      }

      const blockedByEntity = isEntityBlocking(bot, tablePos, policy.clearance);
      const botFeet = bot.entity?.position?.floored?.() || null;
      const underBot = botFeet ? (tablePos.x === botFeet.x && tablePos.z === botFeet.z && tablePos.y <= botFeet.y) : false;
      const insideBot = botFeet ? isSameBlock(tablePos, botFeet) : false;
      const candidate = {
        ring,
        tablePos,
        support,
        standPos: stand,
        center: tablePos.offset(0.5, 0, 0.5),
        blockedByEntity,
        underBot,
        insideBot,
        cramped: countSolidNeighbors(bot, stand)
      };
      candidate.score = scoreCandidate(candidate, { bot });
      candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates.slice(0, policy.candidateLimit)[0] || null;
}

function findRepositionCandidate(bot, options = {}) {
  const policy = getPolicy(options.cfg || {}, options);
  const center = bot.entity.position.floored();
  const candidates = [];

  for (const ring of policy.rings) {
    for (const off of ringOffsets(ring)) {
      const standPos = center.offset(off.dx, 0, off.dz).floored();
      if (!canStandAt(bot, standPos, policy)) {
        logCandidateReject(options, { type: "reasoner_candidate_reject", where: "findRepositionCandidate", ring, reason: "cannot_stand", x: standPos.x, y: standPos.y, z: standPos.z });
        continue;
      }
      const candidate = {
        ring,
        standPos,
        center: standPos.offset(0.5, 0, 0.5),
        blockedByEntity: false,
        underBot: false,
        insideBot: false,
        cramped: countSolidNeighbors(bot, standPos)
      };
      candidate.score = scoreCandidate(candidate, { bot });
      candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates.slice(0, policy.candidateLimit)[0] || null;
}

async function moveToPosition(bot, pos, timeoutMs, runCtx) {
  bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 1));
  const started = Date.now();
  let lastProgressBeat = 0;
  while (Date.now() - started < timeoutMs) {
    if (runCtx?.isCancelled?.()) return false;
    const dist = bot.entity.position.distanceTo(pos);
    const now = Date.now();
    if (now - lastProgressBeat >= 2000) {
      try {
        if (typeof runCtx?.reportProgress === "function") {
          runCtx.reportProgress(`reasoner move (${dist.toFixed(1)}m)`, {
            stepAction: runCtx?.currentStepAction || "move",
            distance: Number(dist.toFixed(2))
          });
        }
      } catch {}
      lastProgressBeat = now;
    }
    if (dist <= 1.5) return true;
    await bot.waitForTicks(10);
  }
  return false;
}

async function runWithSelfCorrection(stepName, fn, policy = {}, ctx = {}) {
  const bot = ctx.bot;
  const log = ctx.log || (() => {});
  const cfg = ctx.cfg || {};
  const runCtx = ctx.runCtx;
  const p = getPolicy(cfg, policy);
  const maxCorrections = timeoutsDisabled(cfg)
    ? Math.min(Math.max(0, Number(p.maxCorrections || 0)), 2)
    : Math.max(0, Number(p.maxCorrections || 0));

  for (let attempt = 0; attempt <= maxCorrections; attempt++) {
    if (runCtx?.isCancelled?.()) return { ok: false, status: "cancel", recoverable: false, code: "cancelled", reason: "cancelled" };
    log({ type: "reasoner_try", step: stepName, attempt });
    const result = await fn({ attempt });
    if (result?.ok) return result;
    if (result?.status === "cancel") return result;

    const recoverable = !!result?.recoverable;
    if (!recoverable || attempt >= maxCorrections) {
      log({
        type: "reasoner_step_fail",
        step: stepName,
        attempt,
        recoverable,
        code: result?.code || "unknown",
        reason: result?.reason || "failed"
      });
      return result || { ok: false, recoverable: false, code: "unknown", reason: "failed" };
    }

    const candidate = findRepositionCandidate(bot, { ...p, cfg, log });
    if (!candidate) {
      log({ type: "reasoner_step_fail", step: stepName, attempt, recoverable: true, code: "no_reposition_candidate", reason: "no valid reposition candidate" });
      return {
        ok: false,
        recoverable: false,
        code: "no_reposition_candidate",
        reason: "no valid local reposition",
        nextNeed: "move to open nearby space"
      };
    }

    log({
      type: "reasoner_candidate_pick",
      step: stepName,
      attempt,
      x: candidate.standPos.x,
      y: candidate.standPos.y,
      z: candidate.standPos.z,
      score: candidate.score
    });
    const moved = await moveToPosition(
      bot,
      candidate.standPos,
      Math.max(1000, Number(p.moveTimeoutMs || 12000)),
      runCtx
    );
    log({
      type: "reasoner_reposition",
      step: stepName,
      attempt,
      moved,
      x: candidate.standPos.x,
      y: candidate.standPos.y,
      z: candidate.standPos.z
    });
    if (!moved) continue;
    log({ type: "reasoner_step_recover", step: stepName, attempt, reason: result?.reason || "recoverable failure" });
  }

  return {
    ok: false,
    recoverable: false,
    code: "max_corrections_exceeded",
    reason: "max correction attempts reached",
    nextNeed: "move to open area"
  };
}

function findApproachCandidate(bot, targetPos, options = {}) {
  if (!targetPos) return null;
  const policy = getPolicy(options.cfg || {}, options);
  const candidates = [];
  const rings = policy.rings;

  for (const ring of rings) {
    for (const off of ringOffsets(ring)) {
      const standPos = targetPos.offset(off.dx, 0, off.dz).floored();
      if (!canStandAt(bot, standPos, policy)) {
        logCandidateReject(options, { type: "reasoner_candidate_reject", where: "findApproachCandidate", ring, reason: "cannot_stand", x: standPos.x, y: standPos.y, z: standPos.z });
        continue;
      }
      const candidate = {
        ring,
        standPos,
        center: standPos.offset(0.5, 0, 0.5),
        blockedByEntity: false,
        underBot: false,
        insideBot: false,
        cramped: countSolidNeighbors(bot, standPos)
      };
      candidate.score = scoreCandidate(candidate, { bot });
      candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates.slice(0, policy.candidateLimit)[0] || null;
}

function findStationInteractionCandidate(bot, stationPos, options = {}) {
  return findApproachCandidate(bot, stationPos, options);
}

function findGatherApproachCandidate(bot, resourcePos, options = {}) {
  return findApproachCandidate(bot, resourcePos, options);
}

module.exports = {
  findPlacementCandidate,
  findRepositionCandidate,
  findApproachCandidate,
  findStationInteractionCandidate,
  findGatherApproachCandidate,
  isPlacementFaceClear,
  scoreCandidate,
  runWithSelfCorrection
};
