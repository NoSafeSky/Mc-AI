const fs = require("fs");
const path = require("path");

// Simple contextual bandit with incremental mean rewards and epsilon-greedy selection.

const POLICY_FILE = path.join(__dirname, "../memory/policy.json");

const ACTIONS = ["idle", "stalk", "freeze", "chat", "follow", "roam", "harvest"];

function loadPolicy() {
  try {
    const raw = fs.readFileSync(POLICY_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function savePolicy(pol) {
  fs.writeFileSync(POLICY_FILE, JSON.stringify(pol, null, 2));
}

function keyFromContext(ctx) {
  return [ctx.isNight ? 1 : 0, ctx.distBucket, ctx.ownerLooking ? 1 : 0, ctx.creepy ? 1 : 0].join(":");
}

function distBucket(distance) {
  if (distance < 4) return "near";
  if (distance < 12) return "mid";
  return "far";
}

function selectAction(pol, ctx, epsilon = 0.1, candidates = ACTIONS) {
  const key = keyFromContext(ctx);
  const entry = pol[key] || {};
  // epsilon-greedy
  if (Math.random() < epsilon) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  // pick best mean reward
  let best = candidates[0];
  let bestMean = -Infinity;
  for (const a of candidates) {
    const rec = entry[a];
    const mean = rec ? rec.mean : 0;
    if (mean > bestMean) {
      bestMean = mean;
      best = a;
    }
  }
  return best;
}

function updatePolicy(pol, ctx, action, reward) {
  const key = keyFromContext(ctx);
  if (!pol[key]) pol[key] = {};
  if (!pol[key][action]) pol[key][action] = { n: 0, mean: 0 };
  const rec = pol[key][action];
  rec.n += 1;
  rec.mean += (reward - rec.mean) / rec.n;
  pol[key][action] = rec;
  return pol;
}

module.exports = {
  loadPolicy,
  savePolicy,
  selectAction,
  updatePolicy,
  distBucket,
  keyFromContext,
  ACTIONS
};