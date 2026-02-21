// Minimal auto-crafting: planks -> sticks -> wooden pickaxe if materials exist.

async function craftBasic(bot, log) {
  const mcData = require("minecraft-data")(bot.version);
  const craftingTableId = mcData.itemsByName.crafting_table ? mcData.itemsByName.crafting_table.id : null;

  // Ensure we have planks from logs
  const logItem = bot.inventory.items().find(i => (i.name || "").includes("log"));
  if (logItem) {
    const plankRecipe = bot.recipesFor(mcData.itemsByName.oak_planks.id, null, 1, null)?.[0];
    if (plankRecipe) {
      try { await bot.craft(plankRecipe, 1, null); log({ type: "craft", item: "planks" }); } catch {}
    }
  }

  // Sticks
  const plankItem = bot.inventory.items().find(i => (i.name || "").includes("planks"));
  if (plankItem) {
    const stickRecipe = bot.recipesFor(mcData.itemsByName.stick.id, null, 1, null)?.[0];
    if (stickRecipe) {
      try { await bot.craft(stickRecipe, 1, null); log({ type: "craft", item: "sticks" }); } catch {}
    }
  }

  // Wooden pickaxe (needs crafting table usually, but recipe may allow 2x2; try best effort)
  const stick = bot.inventory.items().find(i => (i.name || "") === "stick");
  const planks = bot.inventory.items().filter(i => (i.name || "").includes("planks"));
  if (stick && planks.length >= 3) {
    const pickRecipe = bot.recipesFor(mcData.itemsByName.wooden_pickaxe.id, null, 1, null)?.[0];
    if (pickRecipe) {
      try { await bot.craft(pickRecipe, 1, null); log({ type: "craft", item: "wooden_pickaxe" }); } catch {}
    }
  }
}

module.exports = craftBasic;