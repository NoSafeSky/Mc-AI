const { goals, Movements } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");

function lookDirFromYawPitch(yaw, pitch) {
  // Mineflayer yaw/pitch are radians.
  // Approx MC look vector:
  const x = -Math.sin(yaw) * Math.cos(pitch);
  const y =  Math.sin(pitch);
  const z = -Math.cos(yaw) * Math.cos(pitch);
  return new Vec3(x, y, z).normalize();
}

function isLookingAtBot(bot, player, maxAngleDeg = 12) {
  if (player.yaw == null || player.pitch == null) return false;

  const look = lookDirFromYawPitch(player.yaw, player.pitch);
  const toBot = bot.entity.position.minus(player.position).normalize();

  const dot = Math.max(-1, Math.min(1, look.dot(toBot)));
  const angle = Math.acos(dot) * (180 / Math.PI);
  return angle <= maxAngleDeg;
}

async function stalk(bot, playerName, log) {
  const p = bot.players[playerName]?.entity;
  if (!p) return;

  const mcData = require("minecraft-data")(bot.version);
  const movements = new Movements(bot, mcData);
  movements.canDig = false; // avoid tunneling/mining
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  bot.pathfinder.setMovements(movements);

  // Freeze if they look at us
  if (isLookingAtBot(bot, p)) {
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    log({ type: "stalk_freeze" });
    return;
  }

  const dist = bot.entity.position.distanceTo(p.position);
  const minD = 12, maxD = 24; // tighter but safe

  if (dist < minD) {
    // back off
    const away = bot.entity.position.minus(p.position);
    const awayN = away.distanceTo(new Vec3(0,0,0)) === 0 ? new Vec3(1,0,0) : away.normalize();
    const target = p.position.plus(awayN.scaled(maxD)).floored();

    bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 2));
    log({ type: "stalk_backoff", target: [target.x, target.y, target.z] });
    return;
  }

  if (dist > maxD) {
    // drift closer but keep distance
    bot.pathfinder.setGoal(new goals.GoalNear(p.position.x, p.position.y, p.position.z, maxD));
    log({ type: "stalk_approach" });
    return;
  }

  // in the sweet spot: sometimes stop and watch
  if (Math.random() < 0.7) {
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    log({ type: "stalk_watch" });
  }
}

module.exports = stalk;
