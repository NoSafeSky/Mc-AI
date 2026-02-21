const { goals } = require("mineflayer-pathfinder");
const stalk = require("../skills/stalk");
const harvest = require("../skills/harvest");
const craftBasic = require("../skills/craft_basic");
const { loadPolicy, savePolicy, selectAction, updatePolicy, distBucket } = require("./policy");
const { snapshot } = require("./perception");
const { selectGoal } = require("./goals");

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function isNight(bot) {
  // Minecraft time: 0-24000; night roughly 13000-23000
  const t = bot.time?.time ?? 0;
  return t >= 13000 && t <= 23000;
}

function isOwnerLooking(bot, owner) {
  if (!owner || owner.yaw == null || owner.pitch == null) return false;
  if (!owner.lookVector) return false;
  const lookVec = owner.lookVector;
  const toBotRaw = bot.entity.position.minus(owner.position);
  if (!toBotRaw) return false;
  const toBot = toBotRaw.normalize();
  if (!toBot || typeof toBot.dot !== "function") return false;
  const dot = Math.max(-1, Math.min(1, lookVec.dot(toBot)));
  const angle = Math.acos(dot) * (180 / Math.PI);
  return angle <= 12;
}

function startAutonomy(bot, getState, setState, log, cfg) {
  if (!cfg.goalAutonomy) {
    log({ type: "autonomy_disabled" });
    return;
  }
  let policy = loadPolicy();
  let lastDecision = null; // { ctx, action }

  const epsilon = cfg.epsilon ?? 0.12;

  // Startup self-check
  log({ type: "startup", policyLoaded: Object.keys(policy).length, epsilon, goalAutonomy: cfg.goalAutonomy !== false });

  // Feedback via chat commands: owner says "rate good" or "rate bad" or "policy stat"
  bot.on("chat", (username, message) => {
    if (username !== cfg.owner) return;
    const lower = message.toLowerCase().trim();
    if (lower.includes("policy stat")) {
      bot.chat("policy saved");
      savePolicy(policy);
      return;
    }
    if (!lastDecision) return;
    if (lower.includes("rate good")) {
      policy = updatePolicy(policy, lastDecision.ctx, lastDecision.action, 1);
      savePolicy(policy);
      log({ type: "policy_feedback", reward: 1, action: lastDecision.action, ctx: lastDecision.ctx });
      bot.chat("noted.");
      lastDecision = null;
    } else if (lower.includes("rate bad")) {
      policy = updatePolicy(policy, lastDecision.ctx, lastDecision.action, -1);
      savePolicy(policy);
      log({ type: "policy_feedback", reward: -1, action: lastDecision.action, ctx: lastDecision.ctx });
      bot.chat("ok.");
      lastDecision = null;
    }
  });

  setInterval(async () => {
    const state = getState();
    if (state.stopped) return;

    // Always tick (no randomness) to avoid idling

    const owner = bot.players[cfg.owner]?.entity;
    if (!owner) return;

    const dist = bot.entity.position.distanceTo(owner.position);

    // Perception & goal
    const p = snapshot(bot, cfg);
    const goal = cfg.goalAutonomy === false ? "follow_owner" : selectGoal(p);

    const ctx = {
      isNight: isNight(bot),
      distBucket: distBucket(dist),
      ownerLooking: isOwnerLooking(bot, owner),
      creepy: !!state.creepy,
      goal
    };

    if (!state.creepy) {
      // mild behavior when not creepy: stay near owner lightly
      if (Math.random() < 0.2) bot.chat("?");
      return;
    }

    // Candidate actions depend on goal
    const actionsForGoal = {
      follow_owner: ["follow", "idle", "chat"],
      gather_wood: ["harvest", "seek", "follow"],
      gather_stone: ["harvest", "seek", "follow"],
      gather_iron: ["harvest", "seek", "follow"],
      food: ["harvest", "seek", "follow"],
      explore: ["roam", "chat", "idle"],
      craft_basic: ["craft", "idle", "chat"]
    };
    const candidates = actionsForGoal[goal] || ["idle", "chat"];

    const action = selectAction(policy, ctx, epsilon, candidates);
    lastDecision = { ctx, action };
    log({ type: "autonomy_decision", action, goal, ctx, p });

    switch (action) {
      case "idle":
        bot.pathfinder.setGoal(null);
        bot.clearControlStates();
        break;
      case "freeze":
        bot.pathfinder.setGoal(null);
        bot.clearControlStates();
        break;
      case "chat":
        if (dist < 12 && Math.random() < 0.6) {
          bot.chat("...");
          log({ type: "creepy_chat" });
        }
        break;
      case "follow": {
        const mcData = require("minecraft-data")(bot.version);
        const movements = new (require("mineflayer-pathfinder").Movements)(bot, mcData);
        movements.allow1by1towers = true;
        movements.allowParkour = false;
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.setGoal(new goals.GoalNear(owner.position.x, owner.position.y, owner.position.z, 2));
        break;
      }
      case "roam": {
        const dx = (Math.random() * 12 - 6) | 0;
        const dz = (Math.random() * 12 - 6) | 0;
        const target = owner.position.offset(dx, 0, dz).floored();
        const mcData = require("minecraft-data")(bot.version);
        const movements = new (require("mineflayer-pathfinder").Movements)(bot, mcData);
        movements.allow1by1towers = true;
        movements.allowParkour = false;
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 2));
        log({ type: "roam", target: [target.x, target.y, target.z] });
        break;
      }
      case "seek": {
        // move a short hop in a random direction around owner to find resources, then next tick may harvest
        const dx = (Math.random() * 14 - 7) | 0;
        const dz = (Math.random() * 14 - 7) | 0;
        const target = owner.position.offset(dx, 0, dz).floored();
        const mcData = require("minecraft-data")(bot.version);
        const movements = new (require("mineflayer-pathfinder").Movements)(bot, mcData);
        movements.allow1by1towers = true;
        movements.allowParkour = false;
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 2));
        log({ type: "seek", target: [target.x, target.y, target.z], goal });
        break;
      }
      case "harvest": {
        // pick nearest interesting block matching goal
        const interesting = p.blocks || [];
        let chosen = null;
        for (const b of interesting) {
          if (goal === "gather_wood" && (b.name.includes("log") || b.name.includes("leaves"))) { chosen = b; break; }
          if (goal === "gather_stone" && b.name.includes("stone")) { chosen = b; break; }
          if (goal === "gather_iron" && b.name.includes("ore")) { chosen = b; break; }
          if (goal === "food" && b.name.includes("grass") ) { chosen = b; break; }
        }
        if (!chosen && interesting.length) chosen = interesting[0];
        if (chosen) {
          try {
            await harvest(bot, chosen, log);
          } catch (e) {
            log({ type: "error", where: "autonomy_harvest", e: String(e) });
          }
        } else {
          log({ type: "harvest_none", goal, nearby: interesting.map(b => b.name).slice(0,5) });
        }
        break;
      }
      case "craft":
        try { await craftBasic(bot, log); } catch (e) { log({ type: "error", where: "autonomy_craft", e: String(e) }); }
        break;
      case "stalk":
      default:
        try {
          await stalk(bot, cfg.owner, log);
        } catch (e) {
          log({ type: "error", where: "autonomy_stalk", e: String(e) });
        }
        break;
    }
  }, rand(30, 60) * 1000);
}

module.exports = { startAutonomy };
