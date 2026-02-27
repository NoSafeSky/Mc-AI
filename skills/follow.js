const { Movements, goals } = require("mineflayer-pathfinder");
const { applyMovementProfile } = require("../brain/motion_controller");

async function follow(bot, playerName, log) {
  const p = bot.players[playerName]?.entity;
  if (!p) { bot.chat("where?"); return; }

  const mcData = require("minecraft-data")(bot.version);
  const movements = new Movements(bot, mcData);
  movements.allow1by1towers = true;
  movements.allowParkour = false;
  movements.canDig = false;
  bot.pathfinder.setMovements(movements);
  applyMovementProfile(bot, bot.__runtimeCfg || {}, log);
  bot.pathfinder.setGoal(new goals.GoalFollow(p, 2), true);

  bot.chat("ok.");
  log({ type: "follow", playerName });
}

module.exports = follow;
