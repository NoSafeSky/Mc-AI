const { goals, Movements } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function isCancelled(runCtx) {
  return !!runCtx?.isCancelled?.();
}

function timeoutsDisabled(cfg = {}) {
  return cfg?.disableTimeouts === true;
}

function reportProgress(runCtx, message, extra = {}) {
  try {
    if (typeof runCtx?.reportProgress === "function") {
      runCtx.reportProgress(message, extra);
    }
  } catch {}
}

async function waitTicksCancelable(bot, ticks, runCtx) {
  let left = Math.max(0, Number(ticks || 0));
  while (left > 0) {
    if (isCancelled(runCtx)) return false;
    const step = Math.min(left, 10);
    await bot.waitForTicks(step);
    left -= step;
  }
  return true;
}

function movementProfile(cfg = {}) {
  return String(cfg.movementProfile || "default").toLowerCase();
}

function humanLikeEnabled(cfg = {}) {
  return movementProfile(cfg) === "human_cautious" || movementProfile(cfg) === "human_like";
}

function applyMovementProfile(bot, cfg = {}, log = () => {}) {
  if (!bot?.pathfinder || typeof Movements !== "function") return;
  if (!bot?.registry?.blocksByName || !bot?.registry?.itemsByName) return;
  const profile = movementProfile(cfg);
  const current = bot.__motionProfileApplied || null;
  if (current === profile) return;

  const movements = new Movements(bot);
  movements.allow1by1towers = true;
  movements.allowParkour = !!cfg.movementAllowAdvancedParkour;
  movements.canDig = true;
  bot.pathfinder.setMovements(movements);
  bot.__motionProfileApplied = profile;
  log({ type: "movement_profile_applied", profile });
}

function toYawPitch(from, to) {
  const dx = Number(to.x) - Number(from.x);
  const dy = Number(to.y) - Number(from.y);
  const dz = Number(to.z) - Number(from.z);
  const yaw = Math.atan2(-dx, -dz);
  const xz = Math.sqrt(dx * dx + dz * dz);
  const pitch = Math.atan2(dy, xz);
  return { yaw, pitch };
}

function angleDiff(current, target) {
  let d = target - current;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function approachAngle(current, target, maxStep) {
  const d = angleDiff(current, target);
  if (Math.abs(d) <= maxStep) return target;
  return current + Math.sign(d) * maxStep;
}

async function smoothLookAt(bot, targetPos, cfg = {}, runCtx = null) {
  if (typeof bot?.look !== "function" || !bot?.entity?.position) return true;
  const target = targetPos instanceof Vec3
    ? targetPos
    : new Vec3(Number(targetPos?.x || 0), Number(targetPos?.y || 0), Number(targetPos?.z || 0));
  const maxDeg = clamp(cfg.movementLookSmoothingDegPerTick, 2, 90, 12);
  const maxStep = maxDeg * Math.PI / 180;

  const eyes = bot.entity.position.offset(0, 1.62, 0);
  const desired = toYawPitch(eyes, target);
  let yaw = Number(bot.entity.yaw || 0);
  let pitch = Number(bot.entity.pitch || 0);

  for (let i = 0; i < 8; i += 1) {
    if (isCancelled(runCtx)) return false;
    const nextYaw = approachAngle(yaw, desired.yaw, maxStep);
    const nextPitch = approachAngle(pitch, desired.pitch, maxStep);
    await bot.look(nextYaw, nextPitch, true);
    yaw = nextYaw;
    pitch = nextPitch;
    if (Math.abs(angleDiff(yaw, desired.yaw)) < 0.02 && Math.abs(angleDiff(pitch, desired.pitch)) < 0.02) break;
    const ok = await waitTicksCancelable(bot, 1, runCtx);
    if (!ok) return false;
  }
  return true;
}

function randomChance(p) {
  const n = Number(p);
  if (!Number.isFinite(n) || n <= 0) return false;
  if (n >= 1) return true;
  return Math.random() < n;
}

function microPauseEnabled(cfg = {}) {
  if (cfg?.movementDisableMicroPause === true) return false;
  const chance = Number(cfg?.movementMicroPauseChance ?? 0);
  return Number.isFinite(chance) && chance > 0;
}

function msToTicks(ms) {
  return Math.max(1, Math.round(Number(ms || 0) / 50));
}

async function maybeMicroPause(bot, cfg = {}, runCtx = null, log = () => {}) {
  if (!humanLikeEnabled(cfg)) return true;
  if (!microPauseEnabled(cfg)) return true;
  if (!randomChance(cfg.movementMicroPauseChance ?? 0)) return true;
  const minMs = clamp(cfg.movementMicroPauseMsMin, 10, 2000, 90);
  const maxMs = clamp(cfg.movementMicroPauseMsMax, minMs, 3000, 260);
  const duration = Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
  log({ type: "movement_humanize_event", kind: "micro_pause", ms: duration });
  return waitTicksCancelable(bot, msToTicks(duration), runCtx);
}

async function maybeStrafeJitter(bot, cfg = {}, runCtx = null, log = () => {}) {
  if (!humanLikeEnabled(cfg)) return true;
  if (typeof bot?.setControlState !== "function") return true;
  if (!randomChance(cfg.movementStrafeJitterChance ?? 0.12)) return true;
  const dir = Math.random() < 0.5 ? "left" : "right";
  bot.setControlState(dir, true);
  const ok = await waitTicksCancelable(bot, 2, runCtx);
  bot.setControlState(dir, false);
  log({ type: "movement_humanize_event", kind: "strafe_jitter", dir });
  return ok;
}

async function moveNearHuman(bot, pos, radius, timeoutMs, runCtx, cfg = {}, log = () => {}, context = "move") {
  if (!bot?.pathfinder || !bot?.entity?.position) {
    return { status: "fail", code: "path_blocked", reason: "pathfinder unavailable", recoverable: false };
  }

  applyMovementProfile(bot, cfg, log);
  bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, radius));
  const started = Date.now();
  const configuredNoProgressMs = Number(cfg.movementNoProgressTimeoutMs);
  const defaultNoProgressMs = cfg.disableTimeouts === true
    ? 12000
    : (Math.max(5, Number(cfg.taskNoProgressTimeoutSec || 45)) * 1000);
  const noProgressMs = Math.max(
    1000,
    Number.isFinite(configuredNoProgressMs) && configuredNoProgressMs > 0
      ? configuredNoProgressMs
      : defaultNoProgressMs
  );
  let bestDistance = Number.POSITIVE_INFINITY;
  let lastImprovementAt = started;
  let lastProgressAt = 0;
  let lastLookAt = 0;
  let lastPause = 0;

  while (timeoutsDisabled(cfg) || (Date.now() - started < timeoutMs)) {
    if (isCancelled(runCtx)) return { status: "cancel" };
    const dist = bot.entity.position.distanceTo(pos);
    if (dist + 0.05 < bestDistance) {
      bestDistance = dist;
      lastImprovementAt = Date.now();
    }
    if (dist <= radius) return { status: "success" };

    const now = Date.now();
    if (now - lastProgressAt >= 2000) {
      reportProgress(runCtx, `moving (${dist.toFixed(1)}m)`, {
        stepAction: runCtx?.currentStepAction || "move",
        distance: Number(dist.toFixed(2))
      });
      lastProgressAt = now;
    }
    if (now - lastImprovementAt >= noProgressMs) {
      return {
        status: "timeout",
        code: "path_blocked",
        reason: `path stalled (${context})`,
        recoverable: true
      };
    }
    if (humanLikeEnabled(cfg) && now - lastLookAt >= 600) {
      const targetLook = new Vec3(pos.x + 0.5, pos.y + 0.7, pos.z + 0.5);
      await smoothLookAt(bot, targetLook, cfg, runCtx);
      lastLookAt = now;
    }
    if (humanLikeEnabled(cfg) && now - lastPause >= 1800) {
      const okPause = await maybeMicroPause(bot, cfg, runCtx, log);
      if (!okPause) return { status: "cancel" };
      lastPause = now;
    }

    const waited = await waitTicksCancelable(bot, 10, runCtx);
    if (!waited) return { status: "cancel" };
  }

  return {
    status: "timeout",
    code: "path_blocked",
    reason: bestDistance < Number.POSITIVE_INFINITY ? `path blocked (${context})` : "timeout",
    recoverable: true
  };
}

module.exports = {
  applyMovementProfile,
  moveNearHuman,
  smoothLookAt,
  maybeMicroPause,
  maybeStrafeJitter,
  __test: {
    toYawPitch,
    angleDiff,
    approachAngle,
    humanLikeEnabled
  }
};
