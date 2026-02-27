function normalizeItemName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/^minecraft:/, "")
    .trim();
}

function inventoryRows(bot) {
  if (!bot?.inventory) return [];
  if (typeof bot.inventory.items === "function") {
    const listed = bot.inventory.items();
    if (Array.isArray(listed)) return listed;
  }
  const slotRows = Array.isArray(bot.inventory.slots) ? bot.inventory.slots.filter(Boolean) : [];
  if (slotRows.length) return slotRows;
  return [];
}

function canonicalInventory(bot) {
  const rows = inventoryRows(bot);
  const byName = new Map();
  for (const row of rows) {
    const key = normalizeItemName(row?.name);
    if (!key) continue;
    const prev = byName.get(key) || 0;
    byName.set(key, prev + (Number(row?.count) || 0));
  }

  const inventory = {};
  for (const [name, count] of byName.entries()) {
    inventory[name] = count;
  }
  return inventory;
}

function inventoryFamilies(inventory = {}) {
  let log = 0;
  let planks = 0;
  for (const [name, count] of Object.entries(inventory || {})) {
    const key = normalizeItemName(name);
    const n = Number(count || 0);
    if (!key || !Number.isFinite(n) || n <= 0) continue;
    if (key === "log" || /(_log|_stem|_hyphae)$/.test(key)) log += n;
    if (key === "planks" || /_planks$/.test(key)) planks += n;
  }
  return { log, planks };
}

function equippedToolTiers(bot) {
  const inv = canonicalInventory(bot);
  const tiers = {
    pickaxe: null,
    axe: null,
    shovel: null,
    sword: null
  };
  const rank = ["wooden", "stone", "iron", "diamond", "netherite"];

  for (const tool of Object.keys(tiers)) {
    let best = null;
    let bestRank = -1;
    for (const tier of rank) {
      const name = `${tier}_${tool}`;
      if ((inv[name] || 0) > 0 && rank.indexOf(tier) > bestRank) {
        best = tier;
        bestRank = rank.indexOf(tier);
      }
    }
    tiers[tool] = best;
  }
  return tiers;
}

function detectNearbyStations(bot, cfg = {}, radius = 8) {
  const supportedStations = Array.isArray(cfg.supportedStations) && cfg.supportedStations.length
    ? cfg.supportedStations
    : ["inventory", "crafting_table", "furnace", "smoker", "blast_furnace", "stonecutter"];
  const mcData = require("minecraft-data")(bot.version);
  const out = {};

  for (const station of supportedStations) {
    if (station === "inventory") {
      out.inventory = { available: true, position: bot.entity?.position?.floored?.() || null };
      continue;
    }
    const blockId = mcData.blocksByName?.[station]?.id;
    if (!blockId) {
      out[station] = { available: false, position: null };
      continue;
    }
    const block = bot.findBlock({ matching: blockId, maxDistance: radius });
    out[station] = { available: !!block, position: block?.position || null };
  }
  return out;
}

function detectNearbyResources(bot, cfg = {}, radius = null) {
  const maxDistance = radius || cfg.autoGatherRadius || cfg.craftGatherRadius || 48;
  const probes = [
    { key: "logs", match: (b) => !!b && /(_log|_stem|_hyphae)$/.test(String(b.name || "")) },
    { key: "stone", match: (b) => !!b && (b.name === "stone" || b.name === "cobblestone") },
    { key: "cobblestone", match: (b) => !!b && b.name === "cobblestone" },
    { key: "cobbled_deepslate", match: (b) => !!b && b.name === "cobbled_deepslate" },
    { key: "blackstone", match: (b) => !!b && b.name === "blackstone" },
    { key: "wheat", match: (b) => !!b && b.name === "wheat" },
    { key: "carrots", match: (b) => !!b && b.name === "carrots" },
    { key: "potatoes", match: (b) => !!b && b.name === "potatoes" }
  ];
  const out = {};

  for (const probe of probes) {
    const block = bot.findBlock({ matching: probe.match, maxDistance });
    out[probe.key] = { available: !!block, position: block?.position || null };
  }
  return out;
}

function buildCapabilitySnapshot(bot, cfg = {}) {
  const inventory = canonicalInventory(bot);
  return {
    inventory,
    inventoryFamilies: inventoryFamilies(inventory),
    nearbyStations: detectNearbyStations(bot, cfg),
    nearbyResources: detectNearbyResources(bot, cfg),
    equippedToolTiers: equippedToolTiers(bot),
    environmentFlags: {
      canCollectBlock: !!bot.collectBlock,
      hasPathfinder: !!bot.pathfinder,
      version: bot.version
    }
  };
}

module.exports = {
  normalizeItemName,
  inventoryRows,
  canonicalInventory,
  inventoryFamilies,
  equippedToolTiers,
  detectNearbyStations,
  detectNearbyResources,
  buildCapabilitySnapshot
};
