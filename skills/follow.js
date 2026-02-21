const { Movements, goals } = require("mineflayer-pathfinder");

async function follow(bot, playerName, log) {
  const p = bot.players[playerName]?.entity;
  if (!p) { bot.chat("where?"); return; }

  const mcData = require("minecraft-data")(bot.version);
  const movements = new Movements(bot, mcData);
  movements.allow1by1towers = true;
  movements.allowParkour = false;
  movements.canDig = false;
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalFollow(p, 2), true);

  bot.chat("ok.");
  log({ type: "follow", playerName });
}

module.exports = follow;
