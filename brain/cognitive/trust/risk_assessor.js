const TRIVIAL = new Set(["stop", "stopall", "missionStatus", "queueStatus", "queueClear", "missionSuggest"]);
const LOW = new Set(["follow", "come", "gather_block", "craftItem", "giveItem", "dropAllItems", "stashNow"]);
const MEDIUM = new Set(["attackMob", "explore", "regroup"]);

function classifyIntentRisk(intent = {}) {
  const type = String(intent?.type || "").trim();
  if (!type) return "low";
  if (TRIVIAL.has(type)) return "trivial";
  if (LOW.has(type)) return "low";
  if (MEDIUM.has(type)) return "medium";
  return "high";
}

module.exports = {
  classifyIntentRisk
};

