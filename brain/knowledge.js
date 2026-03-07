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
  return countRows(rows);
}

function countRows(rows = []) {
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

function mergeInventoryCounts(...sources) {
  const merged = {};
  for (const source of sources) {
    for (const [name, count] of Object.entries(source || {})) {
      const key = normalizeItemName(name);
      const n = Number(count || 0);
      if (!key || !Number.isFinite(n) || n <= 0) continue;
      merged[key] = Number(merged[key] || 0) + n;
    }
  }
  return merged;
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

function stationCache(bot) {
  const cache = bot?.__stationInventoryCache;
  if (!cache || typeof cache !== "object") return null;
  return cache;
}

function stationInventoryCounts(bot) {
  return mergeInventoryCounts(stationCache(bot)?.counts || {});
}

function stationInventorySources(bot) {
  const cache = stationCache(bot);
  return Array.isArray(cache?.sources) ? cache.sources.slice() : [];
}

function containerRows(container) {
  if (!container) return [];
  if (typeof container.containerItems === "function") {
    const rows = container.containerItems();
    if (Array.isArray(rows)) return rows;
  }
  if (typeof container.items === "function") {
    const rows = container.items();
    if (Array.isArray(rows)) return rows;
  }
  if (Array.isArray(container.slots)) {
    return container.slots.filter(Boolean);
  }
  return [];
}

function openableStationNames(cfg = {}) {
  const supported = Array.isArray(cfg.supportedStations) && cfg.supportedStations.length
    ? cfg.supportedStations.map((name) => normalizeItemName(name))
    : ["inventory", "crafting_table", "furnace", "smoker", "blast_furnace", "stonecutter"];
  const names = new Set(["chest", "trapped_chest", "barrel"]);
  for (const name of supported) {
    if (name === "furnace" || name === "smoker" || name === "blast_furnace") names.add(name);
  }
  return Array.from(names.values());
}

async function openStationView(bot, block, stationName) {
  const name = normalizeItemName(stationName || block?.name || "");
  if (!bot || !block || !name) return null;
  if ((name === "furnace" || name === "smoker" || name === "blast_furnace") && typeof bot.openFurnace === "function") {
    try {
      return { kind: "furnace", handle: await bot.openFurnace(block) };
    } catch {
      return null;
    }
  }
  if (typeof bot.openChest === "function") {
    try {
      return { kind: "container", handle: await bot.openChest(block) };
    } catch {}
  }
  if (typeof bot.openContainer === "function") {
    try {
      return { kind: "container", handle: await bot.openContainer(block) };
    } catch {}
  }
  return null;
}

function pushStationRow(counts, sources, row, stationName, position, slot = "container") {
  const itemName = normalizeItemName(row?.name);
  const count = Number(row?.count || 0);
  if (!itemName || !Number.isFinite(count) || count <= 0) return;
  counts[itemName] = Number(counts[itemName] || 0) + count;
  sources.push({
    stationType: normalizeItemName(stationName),
    position: position ? { x: position.x, y: position.y, z: position.z } : null,
    slot,
    itemName,
    count,
    itemType: Number.isFinite(Number(row?.type)) ? Number(row.type) : null,
    metadata: row?.metadata ?? null
  });
}

function countOpenStationView(view, stationName, position) {
  const counts = {};
  const sources = [];
  if (!view?.handle) return { counts, sources };
  if (view.kind === "furnace") {
    pushStationRow(counts, sources, view.handle.inputItem?.(), stationName, position, "input");
    pushStationRow(counts, sources, view.handle.fuelItem?.(), stationName, position, "fuel");
    pushStationRow(counts, sources, view.handle.outputItem?.(), stationName, position, "output");
    return { counts, sources };
  }
  for (const row of containerRows(view.handle)) {
    pushStationRow(counts, sources, row, stationName, position, "container");
  }
  return { counts, sources };
}

async function refreshNearbyStationInventory(bot, cfg = {}, log = () => {}) {
  if (!bot?.version || typeof bot.findBlocks !== "function" || typeof bot.blockAt !== "function") {
    const existing = stationCache(bot);
    if (existing) return existing;
    const empty = {
      refreshedAt: Date.now(),
      counts: {},
      sources: [],
      stations: {},
      radius: Math.max(2, Math.min(6, Number(cfg.stationSearchRadius || 6)))
    };
    if (bot) bot.__stationInventoryCache = empty;
    return empty;
  }

  const mcData = require("minecraft-data")(bot.version);
  const radius = Math.max(2, Math.min(
    Number(cfg.stationSearchRadius || 32),
    Number(cfg.stationInventoryScanRadius || 6)
  ));
  const perTypeLimit = Math.max(1, Number(cfg.stationInventoryScanLimit || 4));
  const counts = {};
  const sources = [];
  const stations = {};
  const seen = new Set();

  for (const stationName of openableStationNames(cfg)) {
    const blockId = mcData.blocksByName?.[stationName]?.id;
    if (!blockId) continue;
    const positions = bot.findBlocks({ matching: blockId, maxDistance: radius, count: perTypeLimit }) || [];
    for (const pos of positions) {
      const key = `${pos.x}|${pos.y}|${pos.z}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const block = bot.blockAt(pos);
      if (!block?.position) continue;
      const view = await openStationView(bot, block, stationName);
      if (!view?.handle) continue;
      try {
        const counted = countOpenStationView(view, stationName, block.position);
        const stationCounts = counted.counts || {};
        Object.assign(stations, {
          [normalizeItemName(stationName)]: {
            available: true,
            position: block.position,
            counts: stationCounts
          }
        });
        Object.assign(counts, mergeInventoryCounts(counts, stationCounts));
        sources.push(...(counted.sources || []));
      } finally {
        try {
          view.handle.close?.();
        } catch {}
      }
    }
  }

  const cache = {
    refreshedAt: Date.now(),
    counts,
    sources,
    stations,
    radius
  };
  bot.__stationInventoryCache = cache;
  try {
    log({
      type: "station_inventory_snapshot",
      radius,
      stations: Object.keys(stations).length,
      items: Object.keys(counts).length
    });
  } catch {}
  return cache;
}

function buildCapabilitySnapshot(bot, cfg = {}) {
  const inventoryBase = canonicalInventory(bot);
  const stationInventory = stationInventoryCounts(bot);
  const inventory = mergeInventoryCounts(inventoryBase, stationInventory);
  return {
    inventory,
    inventoryBase,
    stationInventory,
    stationInventorySources: stationInventorySources(bot),
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
  countRows,
  mergeInventoryCounts,
  inventoryFamilies,
  equippedToolTiers,
  detectNearbyStations,
  detectNearbyResources,
  stationInventoryCounts,
  refreshNearbyStationInventory,
  buildCapabilitySnapshot
};
