async function stopall(bot, log) {
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  bot.chat("ok.");
  log({ type: "stop" });
}

module.exports = stopall;
