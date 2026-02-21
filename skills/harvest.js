const { Movements, goals } = require("mineflayer-pathfinder");

// Harvest exposed blocks. Tries to move very close before digging to reduce aborts.

function pickPlaceable(bot) {
  const items = bot.inventory.items();
  const preferred = ["dirt", "cobblestone", "planks", "stone", "sand", "gravel"];
  for (const name of preferred) {
    const it = items.find((i) => i.name.includes(name));
    if (it) return it;
  }
  return items[0] || null;
}

async function placeBlockUnder(bot, log) {
  const placeItem = pickPlaceable(bot);
  if (!placeItem) {
    log({ type: "pillar_fail", reason: "no_placeable" });
    return false;
  }

  const blockBelow = bot.blockAt(bot.entity.position.offset(0, -1, 0));
  const emptyBelow = !blockBelow || blockBelow.boundingBox === "empty";
  if (!emptyBelow) {
    log({ type: "pillar_fail", reason: "blocked_below" });
    return false;
  }

  const reference = bot.blockAt(bot.entity.position.offset(0, -1, 0)) || bot.blockAt(bot.entity.position.offset(0, -2, 0));
  if (!reference) {
    log({ type: "pillar_fail", reason: "no_reference" });
    return false;
  }

  try {
    await bot.equip(placeItem, "hand");
    // jump-place to ensure placement (fast timing)
    bot.setControlState("jump", true);
    await bot.waitForTicks(1);
    await bot.placeBlock(reference, { x: 0, y: 1, z: 0 });
    bot.setControlState("jump", false);
    log({ type: "pillar_place", item: placeItem.name });
    return true;
  } catch (e) {
    // quick retry once
    try {
      await bot.equip(placeItem, "hand");
      bot.setControlState("jump", true);
      await bot.waitForTicks(1);
      await bot.placeBlock(reference, { x: 0, y: 1, z: 0 });
      bot.setControlState("jump", false);
      log({ type: "pillar_place_retry", item: placeItem.name });
      return true;
    } catch (e2) {
      bot.setControlState("jump", false);
      log({ type: "error", where: "pillar_place", e: String(e2) });
      return false;
    }
  }
}

async function harvest(bot, targetBlock, log) {
  if (!targetBlock) return;
  const mcData = require("minecraft-data")(bot.version);
  const mov = new Movements(bot, mcData);
  mov.canDig = true;
  mov.allow1by1towers = false;
  mov.allowParkour = false;
  bot.pathfinder.setMovements(mov);

  // Move near the block (radius 2 for smoother approach)
  bot.pathfinder.setGoal(new goals.GoalNear(targetBlock.pos.x, targetBlock.pos.y, targetBlock.pos.z, 2));
  await bot.waitForTicks(15);

  const block = bot.blockAt(targetBlock.pos);
  if (!block) return;

  // If log is too high, try pillar up
  const heightDiff = block.position.y - bot.entity.position.y;
  if (heightDiff > 3) {
    // attempt to pillar up a few times
    for (let i = 0; i < heightDiff; i++) {
      const placed = await placeBlockUnder(bot, log);
      if (!placed) break;
      await bot.waitForTicks(0);
    }
  }

  // Face the block to improve dig success
  try { await bot.lookAt(block.position.offset(0.5, 0.5, 0.5)); } catch {}

  try {
    await bot.dig(block, true);
    log({ type: "harvest", block: block.name, pos: block.position });
  } catch (e) {
    log({ type: "error", where: "harvest", e: String(e) });
  }
}

module.exports = harvest;