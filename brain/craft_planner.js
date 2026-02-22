const { isSupportedCraftItem } = require("./crafting_catalog");

const CRAFT_GRAPH = {
  planks: { output: 4, ingredients: { log: 1 }, needsTable: false },
  stick: { output: 4, ingredients: { planks: 2 }, needsTable: false },
  crafting_table: { output: 1, ingredients: { planks: 4 }, needsTable: false },

  wooden_sword: { output: 1, ingredients: { planks: 2, stick: 1 }, needsTable: true },
  wooden_pickaxe: { output: 1, ingredients: { planks: 3, stick: 2 }, needsTable: true },
  wooden_axe: { output: 1, ingredients: { planks: 3, stick: 2 }, needsTable: true },
  wooden_shovel: { output: 1, ingredients: { planks: 1, stick: 2 }, needsTable: true },
  wooden_hoe: { output: 1, ingredients: { planks: 2, stick: 2 }, needsTable: true },

  stone_sword: { output: 1, ingredients: { cobblestone: 2, stick: 1 }, needsTable: true },
  stone_pickaxe: { output: 1, ingredients: { cobblestone: 3, stick: 2 }, needsTable: true },
  stone_axe: { output: 1, ingredients: { cobblestone: 3, stick: 2 }, needsTable: true },
  stone_shovel: { output: 1, ingredients: { cobblestone: 1, stick: 2 }, needsTable: true },
  stone_hoe: { output: 1, ingredients: { cobblestone: 2, stick: 2 }, needsTable: true }
};

function addEnsureSteps(item, count, steps, recursion = new Set()) {
  if (count <= 0) return;
  if (recursion.has(item)) return;
  recursion.add(item);
  steps.push({ action: "ensure_item", item, count });

  if (item === "log") {
    steps.push({ action: "gather_log", item: "log", count });
    recursion.delete(item);
    return;
  }

  if (item === "cobblestone") {
    steps.push({ action: "acquire_pickaxe", tool: "wooden_pickaxe", count: 1 });
    steps.push({ action: "mine_cobble", item: "cobblestone", count });
    recursion.delete(item);
    return;
  }

  const node = CRAFT_GRAPH[item];
  if (!node) {
    recursion.delete(item);
    return;
  }

  const runs = Math.max(1, Math.ceil(count / node.output));
  for (const [ing, qty] of Object.entries(node.ingredients)) {
    addEnsureSteps(ing, qty * runs, steps, recursion);
  }
  if (node.needsTable) steps.push({ action: "ensure_table" });
  steps.push({ action: "craft", item, count, runs });
  recursion.delete(item);
}

function buildCraftPlan(bot, item, count, cfg = {}) {
  if (!item || !isSupportedCraftItem(item)) {
    return {
      ok: false,
      reason: `unsupported craft item: ${item || "unknown"}`,
      nextNeed: "request supported wood/stone-tier item"
    };
  }

  const mcData = require("minecraft-data")(bot.version);
  if (!mcData.itemsByName[item]) {
    return {
      ok: false,
      reason: `unknown item id: ${item}`,
      nextNeed: "update supported catalog for this version"
    };
  }

  const steps = [];
  addEnsureSteps(item, Math.max(1, count || 1), steps);
  if (!steps.length) {
    return {
      ok: false,
      reason: `unable to build craft plan for ${item}`,
      nextNeed: "check recipe graph"
    };
  }

  return {
    ok: true,
    item,
    count: Math.max(1, count || 1),
    timeoutSec: cfg.craftJobTimeoutSec || 90,
    steps
  };
}

module.exports = {
  buildCraftPlan,
  CRAFT_GRAPH
};
