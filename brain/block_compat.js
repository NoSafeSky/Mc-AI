const TIER_ORDER = ["wooden", "stone", "iron", "diamond", "netherite"];

function normalizeItemName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/^minecraft:/, "")
    .trim();
}

function parseToolName(itemName) {
  const name = normalizeItemName(itemName);
  const match = /^(wooden|stone|iron|diamond|netherite|golden)_([a-z]+)$/.exec(name);
  if (!match) return null;
  return {
    tier: match[1] === "golden" ? "wooden" : match[1],
    toolType: match[2]
  };
}

function getBlockToolRequirement(block, mcData) {
  if (!block || !mcData) return null;
  const harvestTools = block.harvestTools || {};
  const acceptedTools = Object.keys(harvestTools)
    .map((id) => mcData.items?.[Number(id)]?.name)
    .filter(Boolean)
    .map(normalizeItemName);

  if (!acceptedTools.length) return null;

  const parsed = acceptedTools
    .map((name) => ({ name, parsed: parseToolName(name) }))
    .filter((row) => row.parsed);
  if (!parsed.length) return null;

  const toolType = parsed[0].parsed.toolType;
  const minTier = parsed.reduce((best, row) => {
    const tierIndex = TIER_ORDER.indexOf(row.parsed.tier);
    if (best === null || tierIndex < best) return tierIndex;
    return best;
  }, null);

  return {
    toolType,
    minTier: minTier == null ? null : TIER_ORDER[minTier],
    acceptedTools: parsed.map((row) => row.name).sort()
  };
}

function isToolSufficient(itemName, requirement) {
  if (!requirement) return true;
  const normalized = normalizeItemName(itemName);
  if (!normalized) return false;
  const accepted = new Set((requirement.acceptedTools || []).map(normalizeItemName));
  if (accepted.has(normalized)) return true;

  const parsed = parseToolName(normalized);
  if (!parsed) return false;
  if (parsed.toolType !== requirement.toolType) return false;

  const minTier = requirement.minTier || "wooden";
  const currentIdx = TIER_ORDER.indexOf(parsed.tier);
  const minIdx = TIER_ORDER.indexOf(minTier);
  if (currentIdx < 0 || minIdx < 0) return false;
  return currentIdx >= minIdx;
}

function inventoryRows(bot) {
  if (!bot?.inventory) return [];
  if (typeof bot.inventory.items === "function") {
    const listed = bot.inventory.items();
    if (Array.isArray(listed)) return listed;
  }
  const slots = Array.isArray(bot.inventory.slots) ? bot.inventory.slots.filter(Boolean) : [];
  if (slots.length) return slots;
  return [];
}

function pickBestInventoryTool(bot, requirement) {
  if (!requirement) return null;
  const rows = inventoryRows(bot);
  let best = null;
  for (const row of rows) {
    const name = normalizeItemName(row?.name);
    if (!isToolSufficient(name, requirement)) continue;
    const parsed = parseToolName(name);
    const tierIdx = parsed ? TIER_ORDER.indexOf(parsed.tier) : -1;
    if (!best || tierIdx > best.tierIdx) {
      best = { item: row, tierIdx };
    }
  }
  return best ? best.item : null;
}

function minimumToolName(requirement) {
  if (!requirement?.toolType) return null;
  const minTier = requirement.minTier || "wooden";
  const tier = TIER_ORDER.includes(minTier) ? minTier : "wooden";
  const candidate = `${tier}_${requirement.toolType}`;
  const accepted = new Set((requirement.acceptedTools || []).map(normalizeItemName));
  if (!accepted.size || accepted.has(candidate)) return candidate;
  return Array.from(accepted).sort()[0] || candidate;
}

module.exports = {
  getBlockToolRequirement,
  isToolSufficient,
  pickBestInventoryTool,
  minimumToolName
};
