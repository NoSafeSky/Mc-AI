// Lightweight perception snapshot for autonomy and bandit context.

function armorTier(bot) {
  const armor = bot.inventory?.armor || [];
  let score = 0;
  for (const item of armor) {
    if (!item) continue;
    const name = item.name || "";
    if (name.includes("netherite")) score = Math.max(score, 5);
    else if (name.includes("diamond")) score = Math.max(score, 4);
    else if (name.includes("iron")) score = Math.max(score, 3);
    else if (name.includes("gold")) score = Math.max(score, 2);
    else if (name.includes("chain")) score = Math.max(score, 2);
    else if (name.includes("leather")) score = Math.max(score, 1);
  }
  return score; // 0-5
}

function hasItem(bot, substring) {
  return bot.inventory?.items().some((i) => (i.name || "").includes(substring)) || false;
}

// Visible block scan (line-of-sight) within render distance. Prioritize trees.
function nearbyInterestingBlocks(bot, radius = 128) {
  const interesting = [];
  const center = bot.entity.position;
  const r = radius;
  // simple LoS filter using bot.world.raycast (if available), fallback to blockAt scan otherwise
  const doRaycast = typeof bot.world?.raycast === "function";

  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -6; dy <= 6; dy++) {
        const pos = center.offset(dx, dy, dz);
        const block = bot.blockAt(pos);
        if (!block) continue;
        const name = block.name;
        if (!name) continue;
        const isTree = name.includes("log") || name.includes("leaves");
        const isInteresting = isTree || name.includes("ore") || name.includes("crafting_table") || name.includes("furnace");
        if (!isInteresting) continue;

        if (doRaycast) {
          const hit = bot.world.raycast(center, pos.minus(center), radius, ({ block }) => !!block && block.position.equals(pos));
          if (!hit) continue; // not visible
        }
        interesting.push({ name, pos: pos.floored() });
      }
    }
  }

  const trees = interesting.filter(b => b.name.includes("log") || b.name.includes("leaves"));
  const rest = interesting.filter(b => !b.name.includes("log") && !b.name.includes("leaves"));
  return [...trees.slice(0, 64), ...rest.slice(0, 32)];
}

function nearbyMobs(bot, radius = 12) {
  const list = [];
  const center = bot.entity.position;
  for (const name of Object.keys(bot.entities)) {
    const e = bot.entities[name];
    if (!e || !e.position || e.id === bot.entity.id) continue;
    const dist = e.position.distanceTo(center);
    if (dist <= radius && e.type === "mob") {
      list.push({ kind: e.kind || e.name || "mob", dist });
    }
  }
  return list.slice(0, 20);
}

function snapshot(bot, cfg) {
  const time = bot.time?.time ?? 0;
  const isNight = time >= 13000 && time <= 23000;
  const hp = bot.health ?? 20;
  const food = bot.food ?? 20;
  const arm = armorTier(bot);
  const hasWood = hasItem(bot, "log") || hasItem(bot, "planks");
  const hasStone = hasItem(bot, "stone") || hasItem(bot, "cobblestone");
  const hasIron = hasItem(bot, "iron_ingot");
  const hasCoal = hasItem(bot, "coal");
  const mobs = nearbyMobs(bot, 12);
  const blocks = nearbyInterestingBlocks(bot, 6);
  const owner = bot.players[cfg.owner]?.entity;
  const ownerDist = owner ? bot.entity.position.distanceTo(owner.position) : null;

  return {
    isNight,
    hp,
    food,
    armor: arm,
    hasWood,
    hasStone,
    hasIron,
    hasCoal,
    mobs,
    blocks,
    ownerDist,
  };
}

module.exports = { snapshot };