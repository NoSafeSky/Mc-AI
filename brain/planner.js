const follow = require("../skills/follow");
const come = require("../skills/come");
const stopall = require("../skills/stopall");
const stalk = require("../skills/stalk");
const harvest = require("../skills/harvest");
const craftBasic = require("../skills/craft_basic");
const { llmPlan } = require("./llm_plan");
const { goals, Movements } = require("mineflayer-pathfinder");

async function planAndRun(bot, intent, getState, setState, log, cfg) {
  if (intent.type === "stalk") {
    const state = getState();
    state.creepy = true;      // stalk implies creepy mode ON
    setState(state);
    await stalk(bot, intent.target || cfg.owner, log); // do it NOW, not later
    bot.chat("ok.");
    return;
  }

  if (intent.type === "follow") {
    return follow(bot, intent.target || cfg.owner, log);
  }

  if (intent.type === "come") {
    return come(bot, intent.target || cfg.owner, log);
  }

  if (intent.type === "stop") {
    return stopall(bot, log);
  }

  if (intent.type === "stopall") {
    return stopall(bot, log);
  }

  if (intent.type === "harvest") {
    const state = getState();
    state.creepy = true; // enable autonomy behavior
    setState(state);
    // Immediate harvest using collectBlock if available
    const mcData = require("minecraft-data")(bot.version);
    const logBlocks = bot.findBlocks({
      matching: (block) => block && block.name.includes("log"),
      maxDistance: 128,
      count: 64
    });
    if (!logBlocks || logBlocks.length === 0) {
      bot.chat("no trees");
      log({ type: "harvest_none" });
      return;
    }

    const logTargets = logBlocks.map((pos) => bot.blockAt(pos)).filter(Boolean);
    if (bot.collectBlock && logTargets.length) {
      bot.chat("harvesting...");
      log({ type: "harvest_command", count: logTargets.length });

      // Collect logs until none remain near the first log (tree cluster)
      const clusterOrigin = logTargets[0].position;
      const clusterRadius = 6;
      let loops = 0;
      while (loops < 20) {
        const nearbyLogs = bot.findBlocks({
          matching: (block) => block && block.name.includes("log"),
          maxDistance: clusterRadius,
          count: 16
        }).map((pos) => bot.blockAt(pos)).filter(Boolean);

        if (!nearbyLogs.length) {
          log({ type: "tree_complete" });
          break;
        }

        try {
          await bot.collectBlock.collect(nearbyLogs[0]);
        } catch (e) {
          log({ type: "harvest_error", e: String(e) });
          break;
        }
        loops += 1;
      }
      return;
    }

    // Fallback to manual harvest if collectBlock not available
    await harvest(bot, { pos: logBlocks[0] }, log);
    return;
  }

  if (intent.type === "resume") {
    const state = getState();
    state.stopped = false;
    setState(state);
    bot.chat("resumed.");
    log({ type: "resume" });
    return;
  }

  if (intent.type === "setCreepy") {
    const state = getState();
    state.creepy = !!intent.value;
    setState(state);
    bot.chat(state.creepy ? "creepy on." : "creepy off.");
    log({ type: "setCreepy", value: state.creepy });
    return;
  }

  if (intent.type === "freeform" && intent.message) {
    const plan = await llmPlan(intent.message, cfg, getState());
    log({ type: "plan", message: intent.message, plan });
    if (!plan) {
      bot.chat("not sure.");
      return;
    }
    for (const step of plan.steps) {
      if (step.action === "followOwner") {
        await follow(bot, cfg.owner, log);
      } else if (step.action === "comeOwner") {
        await come(bot, cfg.owner, log);
      } else if (step.action === "harvestWood") {
        await planAndRun(bot, { type: "harvest" }, getState, setState, log, cfg);
      } else if (step.action === "craftBasic") {
        await craftBasic(bot, log);
      } else if (step.action === "explore" || step.action === "seekVillage") {
        const mcData = require("minecraft-data")(bot.version);
        const mov = new Movements(bot, mcData);
        mov.allow1by1towers = true;
        mov.canDig = true;
        bot.pathfinder.setMovements(mov);
        const owner = bot.players[cfg.owner]?.entity;
        const center = owner ? owner.position : bot.entity.position;
        const dx = (Math.random() * step.radius * 2 - step.radius) | 0;
        const dz = (Math.random() * step.radius * 2 - step.radius) | 0;
        const target = center.offset(dx, 0, dz).floored();
        bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 2));
      } else if (step.action === "attackMob") {
        const mobType = step.mobType || "pig";
        const range = cfg.attackRange || 32;
        const timeoutMs = (cfg.attackTimeoutSec || 60) * 1000;
        const start = Date.now();
        let target = null;
        let announced = false;
        const mcData = require("minecraft-data")(bot.version);
        const movements = new Movements(bot, mcData);
        movements.allow1by1towers = true;
        movements.allowParkour = false;
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
        while (Date.now() - start < timeoutMs) {
          const mobs = Object.values(bot.entities)
            .filter((e) => e.type === "mob")
            .map((e) => ({
              e,
              name: String(e.displayName || e.name || "").toLowerCase(),
              kind: String(e.displayName || e.name || "").toLowerCase(),
              alias: null
            }))
            .filter((m) => (m.name && (m.name === mobType || m.name.includes(mobType))) || m.alias === mobType)
            .sort((a, b) => bot.entity.position.distanceTo(a.e.position) - bot.entity.position.distanceTo(b.e.position));

          target = mobs[0]?.e;
          if (!target) {
            if (!announced) {
              const seen = Object.values(bot.entities)
                .filter((e) => e.type === "mob")
                .map((e) => String(e.displayName || e.name || "").toLowerCase())
                .slice(0, 8);
              log({ type: "attack_no_target", mobType, seen });
              announced = true;
            }
            await bot.waitForTicks(10);
            continue;
          }
          const dist = bot.entity.position.distanceTo(target.position);
          if (!announced) {
            log({ type: "attack_target", mobType, target: target.displayName || target.name, dist });
            announced = true;
          }
          if (dist > range) {
            await bot.waitForTicks(10);
            continue;
          }
          if (dist > 3) {
            bot.pathfinder.setGoal(new goals.GoalFollow(target, 1), true);
            await bot.waitForTicks(10);
            continue;
          }
          try {
            bot.attack(target);
          } catch (e) {
            log({ type: "attack_error", mobType, e: String(e) });
          }
          if (!target.isValid) break;
          await bot.waitForTicks(10);
        }
        bot.pathfinder.setGoal(null);
        if (!target) log({ type: "attack_timeout", mobType });
      } else if (step.action === "attackHostile") {
        const hostileNames = new Set(["zombie","skeleton","creeper","spider","witch","enderman"]);
        const hostile = Object.values(bot.entities).find((e) => {
          if (e.type !== "mob") return false;
          const name = String(e.displayName || e.name || "").toLowerCase();
          return hostileNames.has(name);
        });
        if (hostile) bot.attack(hostile);
      } else if (step.action === "huntFood") {
        const passiveNames = new Set(["pig","cow","sheep","chicken"]);
        const passive = Object.values(bot.entities).find((e) => {
          if (e.type !== "mob") return false;
          const name = String(e.displayName || e.name || "").toLowerCase();
          return passiveNames.has(name);
        });
        if (passive) bot.attack(passive);
      } else if (step.action === "wait") {
        await bot.waitForTicks(step.seconds * 20);
      }
    }
    return;
  }
}


module.exports = { planAndRun };
