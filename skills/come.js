const { Movements, goals } = require("mineflayer-pathfinder");

async function come(bot, playerName, log) {
  const p = bot.players[playerName]?.entity;
  if (!p) { bot.chat("where?"); return; }

  const mcData = require("minecraft-data")(bot.version);
  const movements = new Movements(bot, mcData);
  movements.allow1by1towers = true;
  movements.allowParkour = false;
  movements.canDig = false;
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalNear(p.position.x, p.position.y, p.position.z, 1));

  bot.chat("ok.");
  log({ type: "come", playerName });
}

module.exports = come;
