const { goals, Movements } = require("mineflayer-pathfinder");
const harvest = require("../skills/harvest");
const { CRAFT_GRAPH } = require("./craft_planner");
const { getCanonicalEntityName, isLivingNonPlayerEntity } = require("./entities");
const {
  findPlacementCandidate,
  findRepositionCandidate,
  runWithSelfCorrection
} = require("./local_reasoner");
const { runStepWithCorrection } = require("./goal_reasoner");
const {
  getBlockToolRequirement,
  isToolSufficient,
  pickBestInventoryTool,
  minimumToolName
} = require("./block_compat");
const { parseRecipeIngredients, recipeVariantId } = require("./acquisition_registry");
const {
  equivalentInventoryCount,
  normalizePlanningItem
} = require("./item_equivalence");

function normalizeItemName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/^minecraft:/, "")
    .trim();
}

function normalizeToolRequirement(requirement) {
  if (!requirement || typeof requirement !== "object") return null;
  const toolType = normalizeItemName(requirement.toolType || "");
  const minTier = normalizeItemName(requirement.minTier || "");
  const acceptedTools = Array.isArray(requirement.acceptedTools)
    ? requirement.acceptedTools.map((name) => normalizeItemName(name)).filter(Boolean)
    : [];
  if (!toolType) return null;
  return {
    toolType,
    minTier: minTier || "wooden",
    acceptedTools
  };
}

function listInventoryItems(bot) {
  if (!bot?.inventory) return [];
  const fromSlots = Array.isArray(bot.inventory.slots)
    ? bot.inventory.slots.filter(Boolean)
    : [];
  if (fromSlots.length > 0) return fromSlots;
  return typeof bot.inventory.items === "function" ? bot.inventory.items() : [];
}

function inventoryMatchesKey(itemName, key) {
  const normalized = normalizeItemName(itemName);
  const target = normalizeItemName(key);
  if (!normalized || !target) return false;
  if (target === "log") return /(_log|_stem|_hyphae)$/.test(normalized);
  if (target === "planks") return normalized.includes("_planks");
  if (target.endsWith("_log") || target.endsWith("_stem") || target.endsWith("_hyphae")) {
    return /(_log|_stem|_hyphae)$/.test(normalized);
  }
  if (target.endsWith("_planks")) return normalized.includes("_planks");
  if (target === "cobblestone") return normalized === "cobblestone";
  return normalized === target;
}

function findInventoryItem(bot, key) {
  return listInventoryItems(bot).find((i) => inventoryMatchesKey(i?.name, key)) || null;
}

function inventoryCount(bot, key) {
  return listInventoryItems(bot)
    .filter((i) => inventoryMatchesKey(i?.name, key))
    .reduce((a, i) => a + (Number(i?.count) || 0), 0);
}

function reasoningEnabled(cfg = {}) {
  return cfg.reasoningEnabled !== false;
}

function isCancelled(runCtx) {
  return !!runCtx?.isCancelled?.();
}

function reportProgress(runCtx, message, extra = {}) {
  try {
    if (typeof runCtx?.reportProgress === "function") {
      runCtx.reportProgress(message, extra);
    }
  } catch {}
}

async function waitTicks(bot, ticks, runCtx) {
  let left = ticks;
  while (left > 0) {
    if (isCancelled(runCtx)) return false;
    const step = Math.min(left, 10);
    await bot.waitForTicks(step);
    left -= step;
  }
  return true;
}

function normalizeCraftResult(status, reason, nextNeed = null) {
  return { status, reason, nextNeed };
}

function findNearbyCraftingTable(bot, radius = 6) {
  const mcData = require("minecraft-data")(bot.version);
  const id = mcData.blocksByName?.crafting_table?.id;
  if (!id) return null;
  return bot.findBlock({ matching: id, maxDistance: radius });
}

async function moveNear(bot, position, radius, timeoutMs, runCtx) {
  bot.pathfinder.setGoal(new goals.GoalNear(position.x, position.y, position.z, radius));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isCancelled(runCtx)) return false;
    if (bot.entity.position.distanceTo(position) <= radius) return true;
    const ok = await waitTicks(bot, 10, runCtx);
    if (!ok) return false;
  }
  return false;
}

async function moveToExactBlock(bot, position, timeoutMs, runCtx) {
  bot.pathfinder.setGoal(new goals.GoalBlock(position.x, position.y, position.z));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isCancelled(runCtx)) return false;
    const feet = bot.entity.position.floored();
    if (feet.x === position.x && feet.y === position.y && feet.z === position.z) return true;
    const ok = await waitTicks(bot, 10, runCtx);
    if (!ok) return false;
  }
  return false;
}

function makeFail(reason, nextNeed, recoverable, code) {
  return {
    ok: false,
    reason,
    nextNeed: nextNeed || null,
    recoverable: !!recoverable,
    code: code || "failed"
  };
}

function normalizeStepResult(result, fallbackCode) {
  if (result?.ok) return result;
  if (result?.status === "cancel") return { ok: false, status: "cancel", code: "cancelled", reason: "cancelled", recoverable: false };
  return {
    ok: false,
    code: result?.code || fallbackCode || "step_failed",
    reason: result?.reason || "step failed",
    nextNeed: result?.nextNeed || null,
    recoverable: !!result?.recoverable
  };
}

async function moveNearWithReasoning(bot, position, radius, timeoutMs, runCtx, cfg, log, stepName) {
  const reached = await moveNear(bot, position, radius, timeoutMs, runCtx);
  if (reached || !reasoningEnabled(cfg)) return reached;
  if (isCancelled(runCtx)) return false;

  const candidate = findRepositionCandidate(bot, { cfg, log });
  if (!candidate) return false;
  log({
    type: "reasoner_candidate_pick",
    step: stepName,
    x: candidate.standPos.x,
    y: candidate.standPos.y,
    z: candidate.standPos.z,
    score: candidate.score
  });

  const fallbackMove = await moveNear(
    bot,
    candidate.standPos,
    1,
    cfg.reasoningMoveTimeoutMs || 12000,
    runCtx
  );
  log({
    type: "reasoner_reposition",
    step: stepName,
    moved: fallbackMove,
    x: candidate.standPos.x,
    y: candidate.standPos.y,
    z: candidate.standPos.z
  });
  if (!fallbackMove) return false;
  return moveNear(bot, position, radius, timeoutMs, runCtx);
}

async function legacyEnsureTablePlaced(bot, cfg, runCtx, log) {
  let table = findNearbyCraftingTable(bot, 8);
  if (table) {
    log({ type: "craft_step_ok", action: "ensure_table", reused: true });
    return { ok: true, table };
  }

  const placeItem = findInventoryItem(bot, "crafting_table");
  if (!placeItem) {
    log({
      type: "inventory_snapshot",
      where: "legacyEnsureTablePlaced",
      counts: {
        crafting_table: inventoryCount(bot, "crafting_table"),
        planks: inventoryCount(bot, "planks"),
        stick: inventoryCount(bot, "stick")
      }
    });
    return makeFail("need crafting table item", "craft crafting_table", false, "missing_table_item");
  }

  const reference = bot.findBlock({
    matching: (block) => !!block && block.boundingBox === "block",
    maxDistance: 4
  });
  if (!reference) {
    return makeFail("no placeable surface for crafting table", "stand near solid ground", false, "no_surface");
  }

  try {
    await bot.equip(placeItem, "hand");
    await bot.placeBlock(reference, { x: 0, y: 1, z: 0 });
    const waited = await waitTicks(bot, 2, runCtx);
    if (!waited) return { ok: false, status: "cancel" };
    table = bot.blockAt(reference.position.offset(0, 1, 0));
    const resolved = table || findNearbyCraftingTable(bot, 6);
    if (!resolved) {
      return makeFail("failed to place crafting table", "clear placement space", true, "table_not_detected");
    }
    log({ type: "craft_step_ok", action: "ensure_table", placed: true });
    return { ok: true, table: resolved };
  } catch (e) {
    return makeFail("failed to place crafting table", "clear placement space", true, "place_failed");
  }
}

async function ensureTablePlaced(bot, cfg, runCtx, log) {
  let table = findNearbyCraftingTable(bot, 8);
  if (table) {
    log({ type: "craft_step_ok", action: "ensure_table", reused: true });
    return { ok: true, table };
  }
  if (!cfg.craftAutoPlaceTable) {
    return makeFail("need crafting table nearby", "place crafting table", false, "missing_table");
  }
  if (inventoryCount(bot, "crafting_table") < 1) {
    log({
      type: "inventory_snapshot",
      where: "ensureTablePlaced",
      counts: {
        crafting_table: inventoryCount(bot, "crafting_table"),
        planks: inventoryCount(bot, "planks"),
        stick: inventoryCount(bot, "stick")
      }
    });
    return makeFail("need crafting table item", "craft crafting_table", false, "missing_table_item");
  }
  if (!reasoningEnabled(cfg)) {
    return legacyEnsureTablePlaced(bot, cfg, runCtx, log);
  }

  const placeAttempt = async () => {
    if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
    const placeItem = findInventoryItem(bot, "crafting_table");
    if (!placeItem) {
      log({
        type: "inventory_snapshot",
        where: "ensureTablePlaced.placeAttempt",
        counts: {
          crafting_table: inventoryCount(bot, "crafting_table"),
          planks: inventoryCount(bot, "planks"),
          stick: inventoryCount(bot, "stick")
        }
      });
      return makeFail("need crafting table item", "craft crafting_table", false, "missing_table_item");
    }
    table = findNearbyCraftingTable(bot, 8);
    if (table) {
      log({ type: "craft_step_ok", action: "ensure_table", reused: true });
      return { ok: true, table };
    }

    const candidate = findPlacementCandidate(bot, { cfg, log });
    if (!candidate) {
      return makeFail(
        "failed to place crafting table",
        "clear placement space near bot",
        false,
        "no_valid_placement_candidate"
      );
    }

    log({
      type: "reasoner_candidate_pick",
      step: "ensure_table_placed",
      x: candidate.tablePos.x,
      y: candidate.tablePos.y,
      z: candidate.tablePos.z,
      standX: candidate.standPos.x,
      standY: candidate.standPos.y,
      standZ: candidate.standPos.z,
      score: candidate.score
    });

    const moved = await moveToExactBlock(
      bot,
      candidate.standPos,
      cfg.reasoningMoveTimeoutMs || 12000,
      runCtx
    );
    if (!moved) {
      return makeFail(
        "failed to place crafting table",
        "clear path for placement",
        true,
        "placement_stand_unreachable"
      );
    }
    if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
    const feet = bot.entity.position.floored();
    if (feet.x === candidate.tablePos.x && feet.y === candidate.tablePos.y && feet.z === candidate.tablePos.z) {
      return makeFail(
        "failed to place crafting table",
        "step off target block",
        true,
        "standing_in_target_cell"
      );
    }

    const reference = bot.blockAt(candidate.tablePos.offset(0, -1, 0));
    if (!reference || reference.boundingBox !== "block") {
      return makeFail("failed to place crafting table", "clear placement space", true, "invalid_support");
    }

    try {
      await bot.equip(placeItem, "hand");
      await bot.placeBlock(reference, { x: 0, y: 1, z: 0 });
    } catch (e) {
      const detail = String(e?.message || e || "");
      const recoverable = /(blocked|occup|space|entity|interact|range|position|path)/i.test(detail);
      return makeFail(
        "failed to place crafting table",
        recoverable ? "clear placement space" : "move to open area",
        recoverable,
        "place_exception"
      );
    }

    const waited = await waitTicks(bot, 2, runCtx);
    if (!waited) return { ok: false, status: "cancel" };

    const placedAtCandidate = bot.blockAt(candidate.tablePos);
    if (placedAtCandidate && placedAtCandidate.name === "crafting_table") {
      return { ok: true, table: placedAtCandidate };
    }
    const nearby = findNearbyCraftingTable(bot, 6);
    if (nearby) return { ok: true, table: nearby };
    return makeFail("failed to place crafting table", "clear placement space", true, "table_not_found_after_place");
  };

  const result = await runWithSelfCorrection(
    "ensure_table_placed",
    placeAttempt,
    {},
    { bot, cfg, runCtx, log }
  );
  if (result?.status === "cancel") return { ok: false, status: "cancel" };
  if (result?.ok) {
    return { ok: true, table: result.table || findNearbyCraftingTable(bot, 8) };
  }
  return makeFail(
    result?.reason || "failed to place crafting table",
    result?.nextNeed || "clear placement space",
    false,
    result?.code || "ensure_table_failed"
  );
}

async function craftCanonical(bot, item, targetCount, tableBlock, runCtx) {
  const mcData = require("minecraft-data")(bot.version);
  const isPlanks = item === "planks";
  const itemInfo = isPlanks ? null : mcData.itemsByName[item];
  if (!isPlanks && !itemInfo) {
    return { ok: false, reason: `unknown craft item ${item}`, nextNeed: "supported item name" };
  }
  let attempts = 0;
  while (inventoryCount(bot, item) < targetCount) {
    if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
    if (attempts > 32) return { ok: false, reason: `craft loop limit for ${item}`, nextNeed: "more source materials" };
    attempts += 1;

    let recipe = null;
    if (isPlanks) {
      const plankIds = Object.values(mcData.itemsByName)
        .filter((it) => it && typeof it.name === "string" && it.name.endsWith("_planks"))
        .map((it) => it.id);
      for (const pid of plankIds) {
        recipe = bot.recipesFor(pid, null, 1, null)?.[0] || null;
        if (recipe) break;
      }
    } else {
      recipe = bot.recipesFor(itemInfo.id, null, 1, tableBlock || null)?.[0]
        || bot.recipesFor(itemInfo.id, null, 1, null)?.[0]
        || null;
    }
    if (!recipe) {
      return { ok: false, reason: `recipe unavailable for ${item}`, nextNeed: "required ingredients or crafting table" };
    }
    try {
      await bot.craft(recipe, 1, tableBlock || null);
    } catch (e) {
      return { ok: false, reason: `craft failed for ${item}`, nextNeed: "required ingredients" };
    }
    const waited = await waitTicks(bot, 2, runCtx);
    if (!waited) return { ok: false, status: "cancel" };
  }
  return { ok: true };
}

async function gatherOneLog(bot, cfg, runCtx, log) {
  const radius = cfg.craftGatherRadius || 48;
  if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
  const before = inventoryCount(bot, "log");
  const pos = bot.findBlock({
    matching: (block) => !!block && /_log$/.test(block.name || ""),
    maxDistance: radius
  });
  if (!pos) return makeFail("no logs nearby", "find logs", false, "no_logs_nearby");

  const block = bot.blockAt(pos.position || pos);
  if (!block) return makeFail("log block unavailable", "move closer to trees", true, "log_block_unavailable");

  const reached = await moveNearWithReasoning(
    bot,
    block.position,
    2,
    cfg.reasoningMoveTimeoutMs || 12000,
    runCtx,
    cfg,
    log,
    "gather_log_move"
  );
  if (!reached) {
    return makeFail("failed gathering logs", "path to tree or clear obstacles", true, "log_path_blocked");
  }

  try {
    if (bot.collectBlock) {
      await bot.collectBlock.collect(block);
    } else {
      await harvest(bot, { pos: block.position }, () => {});
    }
  } catch (e) {
    return makeFail("failed gathering logs", "path to tree or clear obstacles", true, "collect_log_failed");
  }

  const waited = await waitTicks(bot, 2, runCtx);
  if (!waited) return { ok: false, status: "cancel" };
  if (inventoryCount(bot, "log") <= before) {
    return makeFail("failed gathering logs", "move closer to tree", true, "no_log_collected");
  }
  return { ok: true };
}

async function gatherLogs(bot, needed, cfg, runCtx, log) {
  while (inventoryCount(bot, "log") < needed) {
    if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
    const attempt = async () => gatherOneLog(bot, cfg, runCtx, log);
    const result = reasoningEnabled(cfg)
      ? await runWithSelfCorrection("gather_log", attempt, {}, { bot, cfg, runCtx, log })
      : await attempt();
    if (result?.status === "cancel") return { ok: false, status: "cancel" };
    if (!result?.ok) {
      return makeFail(
        result?.reason || "failed gathering logs",
        result?.nextNeed || "find logs",
        false,
        result?.code || "gather_logs_failed"
      );
    }
  }
  return { ok: true };
}

async function ensurePickaxeEquipped(bot) {
  const order = ["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe"];
  const pick = order
    .map((name) => findInventoryItem(bot, name))
    .find(Boolean);
  if (!pick) return false;
  try {
    await bot.equip(pick, "hand");
    return true;
  } catch {
    return false;
  }
}

async function mineOneCobble(bot, cfg, runCtx, log) {
  if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
  const before = inventoryCount(bot, "cobblestone");
  const radius = cfg.craftGatherRadius || 48;
  const pickaxeReady = await ensurePickaxeEquipped(bot);
  if (!pickaxeReady) {
    return makeFail("need pickaxe to mine stone", "craft wooden_pickaxe", false, "missing_pickaxe");
  }

  const block = bot.findBlock({
    matching: (b) => !!b && (b.name === "stone" || b.name === "cobblestone"),
    maxDistance: radius
  });
  if (!block) return makeFail("no stone nearby", "find stone", false, "no_stone_nearby");

  const reached = await moveNearWithReasoning(
    bot,
    block.position,
    2,
    15000,
    runCtx,
    cfg,
    log,
    "mine_cobble_move"
  );
  if (!reached) return makeFail("path blocked to stone", "clear path to stone", true, "stone_path_blocked");

  try {
    const digBlock = bot.blockAt(block.position);
    if (!digBlock) return makeFail("stone block vanished", "find another stone block", true, "stone_vanished");
    await bot.dig(digBlock, true);
  } catch (e) {
    return makeFail("failed mining stone", "equip pickaxe or move closer", true, "mine_stone_failed");
  }
  const waited = await waitTicks(bot, 4, runCtx);
  if (!waited) return { ok: false, status: "cancel" };
  if (inventoryCount(bot, "cobblestone") <= before) {
    return makeFail("failed mining stone", "move closer to stone", true, "no_cobble_collected");
  }
  return { ok: true };
}

async function mineCobble(bot, needed, cfg, runCtx, log) {
  const mcData = require("minecraft-data")(bot.version);
  const movements = new Movements(bot, mcData);
  movements.allow1by1towers = true;
  movements.allowParkour = false;
  movements.canDig = true;
  bot.pathfinder.setMovements(movements);

  while (inventoryCount(bot, "cobblestone") < needed) {
    if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
    const attempt = async () => mineOneCobble(bot, cfg, runCtx, log);
    const result = reasoningEnabled(cfg)
      ? await runWithSelfCorrection("mine_cobble", attempt, {}, { bot, cfg, runCtx, log })
      : await attempt();
    if (result?.status === "cancel") return { ok: false, status: "cancel" };
    if (!result?.ok) {
      return makeFail(
        result?.reason || "failed mining stone",
        result?.nextNeed || "find stone",
        false,
        result?.code || "mine_cobble_failed"
      );
    }
  }

  return { ok: true };
}

async function ensureItem(bot, item, count, cfg, runCtx, log, ctx) {
  if (inventoryCount(bot, item) >= count) return { ok: true };

  if (item === "log") return gatherLogs(bot, count, cfg, runCtx, log);

  if (item === "planks") {
    const missing = Math.max(0, count - inventoryCount(bot, "planks"));
    const runs = Math.ceil(missing / 4);
    const logsNeeded = Math.max(0, runs - inventoryCount(bot, "log"));
    if (logsNeeded > 0) {
      const gotLogs = await ensureItem(bot, "log", inventoryCount(bot, "log") + logsNeeded, cfg, runCtx, log, ctx);
      if (!gotLogs.ok) return gotLogs;
    }
    return craftCanonical(bot, "planks", count, null, runCtx);
  }

  if (item === "stick") {
    const missing = Math.max(0, count - inventoryCount(bot, "stick"));
    const runs = Math.ceil(missing / 4);
    const planksNeeded = runs * 2;
    const gotPlanks = await ensureItem(bot, "planks", inventoryCount(bot, "planks") + planksNeeded, cfg, runCtx, log, ctx);
    if (!gotPlanks.ok) return gotPlanks;
    return craftCanonical(bot, "stick", count, null, runCtx);
  }

  if (item === "crafting_table") {
    const missing = Math.max(0, count - inventoryCount(bot, "crafting_table"));
    if (missing <= 0) return { ok: true };
    const planksNeeded = missing * 4;
    const gotPlanks = await ensureItem(bot, "planks", inventoryCount(bot, "planks") + planksNeeded, cfg, runCtx, log, ctx);
    if (!gotPlanks.ok) return gotPlanks;
    return craftCanonical(bot, "crafting_table", count, null, runCtx);
  }

  if (item === "cobblestone") {
    const pick = await ensureItem(bot, "wooden_pickaxe", 1, cfg, runCtx, log, ctx);
    if (!pick.ok) return pick;
    return mineCobble(bot, count, cfg, runCtx, log);
  }

  const node = CRAFT_GRAPH[item];
  if (!node) return { ok: false, reason: `unsupported craft item ${item}`, nextNeed: "supported wood/stone item" };

  const missing = Math.max(0, count - inventoryCount(bot, item));
  if (missing <= 0) return { ok: true };
  const runs = Math.ceil(missing / node.output);
  for (const [ingredient, qty] of Object.entries(node.ingredients)) {
    const needed = qty * runs;
    const ensured = await ensureItem(bot, ingredient, needed, cfg, runCtx, log, ctx);
    if (!ensured.ok) return ensured;
  }

  let tableBlock = null;
  if (node.needsTable) {
    let tableRes = await ensureTablePlaced(bot, cfg, runCtx, log);
    if (!tableRes.ok && tableRes.code === "missing_table_item" && cfg.craftAutoPlaceTable) {
      const ensuredTableItem = await ensureItem(bot, "crafting_table", 1, cfg, runCtx, log, ctx);
      if (!ensuredTableItem.ok) return ensuredTableItem;
      tableRes = await ensureTablePlaced(bot, cfg, runCtx, log);
    }
    if (!tableRes.ok) return tableRes;
    tableBlock = tableRes.table;
    ctx.tableBlock = tableBlock;
  }
  return craftCanonical(bot, item, count, tableBlock || ctx.tableBlock || null, runCtx);
}

function findNearbyStation(bot, stationName, radius = 8) {
  const mcData = require("minecraft-data")(bot.version);
  const blockId = mcData.blocksByName?.[stationName]?.id;
  if (!blockId) return null;
  return bot.findBlock({ matching: blockId, maxDistance: radius });
}

async function ensureStation(bot, station, cfg, runCtx, log, ctx) {
  if (!station || station === "inventory") return { ok: true };
  if (station === "crafting_table") {
    const tableRes = await ensureTablePlaced(bot, cfg, runCtx, log);
    if (!tableRes.ok) return normalizeStepResult(tableRes, "station_unavailable");
    ctx.stations.crafting_table = tableRes.table;
    return { ok: true, data: tableRes.table };
  }

  const nearby = findNearbyStation(bot, station, 10);
  if (nearby) {
    ctx.stations[station] = nearby;
    return { ok: true, data: nearby };
  }
  return {
    ok: false,
    code: "station_unavailable",
    reason: `need ${station} nearby`,
    nextNeed: `place ${station}`,
    recoverable: false
  };
}

function inventorySnapshot(bot) {
  const out = {};
  for (const row of listInventoryItems(bot)) {
    const name = normalizeItemName(row?.name);
    const count = Number(row?.count || 0);
    if (!name || !Number.isFinite(count) || count <= 0) continue;
    out[name] = (out[name] || 0) + count;
  }
  return out;
}

function exactInventoryCount(snapshot, item) {
  return Number(snapshot?.[normalizeItemName(item)] || 0);
}

function moveTimeoutForDistance(cfg, distance) {
  const base = Math.max(1000, Number(cfg.dynamicMoveTimeoutBaseMs || 12000));
  const perBlock = Math.max(0, Number(cfg.dynamicMoveTimeoutPerBlockMs || 180));
  const estimate = Math.floor(base + Math.max(0, Number(distance || 0)) * perBlock);
  return Math.min(45000, Math.max(1000, estimate));
}

function selectBestCraftRecipe(recipes, item, bot, cfg, log = () => {}) {
  if (!Array.isArray(recipes) || !recipes.length) return null;
  const mcData = require("minecraft-data")(bot.version);
  const inv = inventorySnapshot(bot);
  const preferBamboo = cfg.preferBambooForSticks === true;

  const scored = recipes.map((recipe) => {
    const rawIngredients = parseRecipeIngredients(recipe, mcData);
    const normalizedIngredients = rawIngredients.map((ing) => ({
      name: normalizePlanningItem(ing.name, cfg),
      count: ing.count
    }));
    const exactMissing = rawIngredients.reduce((sum, ing) => {
      return sum + Math.max(0, ing.count - exactInventoryCount(inv, ing.name));
    }, 0);
    const equivalentMissing = normalizedIngredients.reduce((sum, ing) => {
      return sum + Math.max(0, ing.count - equivalentInventoryCount(inv, ing.name, cfg));
    }, 0);
    const bambooPenalty = String(item) === "stick" && !preferBamboo && rawIngredients.some((ing) => ing.name === "bamboo")
      ? 24
      : 0;
    const signature = recipeVariantId(rawIngredients);
    const score = equivalentMissing * 25 + exactMissing * 8 + bambooPenalty;
    const entry = { recipe, score, signature, rawIngredients, equivalentMissing, exactMissing, bambooPenalty };
    log({
      type: "recipe_choice_scored",
      item,
      variantId: signature,
      score,
      scoreBreakdown: {
        equivalentMissing,
        exactMissing,
        bambooPenalty
      },
      ingredients: rawIngredients
    });
    return entry;
  });

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.signature.localeCompare(b.signature);
  });
  return scored[0]?.recipe || null;
}

async function craftRecipeStep(bot, args, cfg, runCtx, log, ctx) {
  const item = normalizeItemName(args?.item);
  const count = Math.max(1, Number(args?.count || 1));
  if (!item) return { ok: false, code: "invalid_item", reason: "invalid craft item", nextNeed: "specify item", recoverable: false };
  if (item === "planks") {
    const res = await ensureItem(bot, "planks", count, cfg, runCtx, log, { tableBlock: null });
    return normalizeStepResult(res, "craft_planks_failed");
  }

  const mcData = require("minecraft-data")(bot.version);
  const outputItem = normalizeItemName(args?.outputItem || item);
  const itemInfo = mcData.itemsByName[outputItem];
  if (!itemInfo) return { ok: false, code: "unknown_item", reason: `unknown item ${item}`, nextNeed: "valid item name", recoverable: false };

  const station = args?.station || "inventory";
  let tableBlock = null;
  if (station === "crafting_table") {
    const ensured = await ensureStation(bot, "crafting_table", cfg, runCtx, log, ctx);
    if (!ensured.ok) return ensured;
    tableBlock = ctx.stations.crafting_table || null;
  }

  let loops = 0;
  while (inventoryCount(bot, item) < count) {
    if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
    if (loops++ > 48) {
      return { ok: false, code: "craft_loop_limit", reason: `craft loop limit for ${item}`, nextNeed: `check ingredients for ${item}`, recoverable: false };
    }

    const tableRecipes = bot.recipesFor(itemInfo.id, null, 1, tableBlock || null) || [];
    const inventoryRecipes = tableBlock ? (bot.recipesFor(itemInfo.id, null, 1, null) || []) : [];
    const recipeCandidates = [...tableRecipes, ...inventoryRecipes];
    let recipe = selectBestCraftRecipe(recipeCandidates, outputItem, bot, cfg, log);
    if (!recipe && args?.recipe) {
      recipe = args.recipe;
    }

    if (!recipe && item.endsWith("_planks")) {
      const plankIds = Object.values(mcData.itemsByName)
        .filter((it) => it && typeof it.name === "string" && it.name.endsWith("_planks"))
        .map((it) => it.id);
      for (const pid of plankIds) {
        const candidates = [
          ...(bot.recipesFor(pid, null, 1, tableBlock || null) || []),
          ...(tableBlock ? (bot.recipesFor(pid, null, 1, null) || []) : [])
        ];
        recipe = selectBestCraftRecipe(candidates, item, bot, cfg, log);
        if (recipe) break;
      }
    }

    if (!recipe) {
      return {
        ok: false,
        code: "recipe_unavailable",
        reason: `recipe unavailable for ${item}`,
        nextNeed: "required ingredients or station",
        recoverable: false
      };
    }

    try {
      await bot.craft(recipe, 1, tableBlock || null);
    } catch (e) {
      return {
        ok: false,
        code: "path_blocked",
        reason: `craft failed for ${item}`,
        nextNeed: "clear crafting space",
        recoverable: true
      };
    }
    const waited = await waitTicks(bot, 2, runCtx);
    if (!waited) return { ok: false, status: "cancel" };
  }
  return { ok: true };
}

function findNearestCandidateBlock(bot, blockNames, preferredBlocks, maxDistance) {
  const matchSet = new Set((blockNames || []).map((n) => normalizeItemName(n)).filter(Boolean));
  if (!matchSet.size) return null;
  const preferred = Array.isArray(preferredBlocks) && preferredBlocks.length
    ? preferredBlocks.map((n) => normalizeItemName(n)).filter(Boolean)
    : Array.from(matchSet.values());
  const preference = new Map(preferred.map((name, idx) => [name, idx]));
  const rankFor = (name) => {
    const key = normalizeItemName(name);
    return preference.has(key) ? preference.get(key) : preferred.length + 10;
  };

  if (typeof bot.findBlocks === "function") {
    const positions = bot.findBlocks({
      matching: (b) => !!b && matchSet.has(normalizeItemName(b.name)),
      maxDistance,
      count: 16
    }) || [];

    const blocks = positions
      .map((p) => bot.blockAt(p))
      .filter(Boolean)
      .sort((a, b) => {
        const pa = rankFor(a.name);
        const pb = rankFor(b.name);
        if (pa !== pb) return pa - pb;
        const da = bot.entity.position.distanceTo(a.position);
        const db = bot.entity.position.distanceTo(b.position);
        if (da !== db) return da - db;
        if (a.position.x !== b.position.x) return a.position.x - b.position.x;
        if (a.position.y !== b.position.y) return a.position.y - b.position.y;
        return a.position.z - b.position.z;
      });
    return blocks[0] || null;
  }

  return bot.findBlock({
    matching: (b) => !!b && matchSet.has(normalizeItemName(b.name)),
    maxDistance
  }) || null;
}

async function gatherBlockStep(bot, args, cfg, runCtx, log) {
  const item = normalizeItemName(args?.item);
  const count = Math.max(1, Number(args?.count || 1));
  const defaultLogs = [
    "oak_log",
    "spruce_log",
    "birch_log",
    "jungle_log",
    "acacia_log",
    "dark_oak_log",
    "mangrove_log",
    "cherry_log",
    "crimson_stem",
    "warped_stem"
  ];
  const blockNames = Array.isArray(args?.blockNames) && args.blockNames.length
    ? args.blockNames.map((n) => normalizeItemName(n))
    : (item === "log" ? defaultLogs : [item]);
  const preferredBlocks = Array.isArray(args?.preferredBlocks) && args.preferredBlocks.length
    ? args.preferredBlocks.map((n) => normalizeItemName(n))
    : [...blockNames];
  const stepRequirement = normalizeToolRequirement(args?.toolRequirement);
  const strictToolGate = cfg.strictHarvestToolGate !== false;
  const autoAcquireRequiredTools = cfg.autoAcquireRequiredTools !== false;
  const mcData = require("minecraft-data")(bot.version);
  const configuredRings = Array.isArray(cfg.gatherRadiusSteps) && cfg.gatherRadiusSteps.length
    ? cfg.gatherRadiusSteps
    : [cfg.autoGatherRadius || cfg.craftGatherRadius || 48];
  const rings = configuredRings
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const retriesPerRing = Math.max(1, Number(cfg.gatherExpandRetryPerRing || 2));

  while (inventoryCount(bot, item) < count) {
    if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
    const maxRing = rings[rings.length - 1] || 48;
    let gatheredThisLoop = false;

    for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
      const radius = rings[ringIndex];
      reportProgress(runCtx, `search ${item} radius ${radius}`, {
        stepAction: "gather_block",
        gatherRingIndex: ringIndex + 1,
        msg: `search ${item} radius ${radius}`
      });

      for (let attempt = 1; attempt <= retriesPerRing; attempt += 1) {
        if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
        reportProgress(runCtx, `gather ${item} r${radius} try ${attempt}/${retriesPerRing}`, {
          stepAction: "gather_block",
          gatherRingIndex: ringIndex + 1,
          attempt
        });

        const block = findNearestCandidateBlock(bot, blockNames, preferredBlocks, radius);
        if (!block) {
          const waitedNoBlock = await waitTicks(bot, 6, runCtx);
          if (!waitedNoBlock) return { ok: false, status: "cancel" };
          continue;
        }

        const dynamicMoveTimeoutMs = moveTimeoutForDistance(
          cfg,
          bot.entity?.position?.distanceTo?.(block.position) || radius
        );

        const reached = await moveNearWithReasoning(
          bot,
          block.position,
          2,
          dynamicMoveTimeoutMs,
          runCtx,
          cfg,
          log,
          "gather_block_move"
        );
        if (!reached) {
          const waitedMoveFail = await waitTicks(bot, 4, runCtx);
          if (!waitedMoveFail) return { ok: false, status: "cancel" };
          continue;
        }

        const before = inventoryCount(bot, item);
        let activeRequirement = null;
        try {
          const digBlock = bot.blockAt(block.position);
          if (!digBlock) {
            const waitedMissing = await waitTicks(bot, 4, runCtx);
            if (!waitedMissing) return { ok: false, status: "cancel" };
            continue;
          }

          if (strictToolGate) {
            activeRequirement = normalizeToolRequirement(getBlockToolRequirement(digBlock, mcData)) || stepRequirement;
            if (activeRequirement) {
              log({
                type: "gather_tool_required",
                item,
                block: normalizeItemName(digBlock.name),
                toolRequirement: activeRequirement
              });
              let equipped = normalizeItemName(bot.heldItem?.name || "");
              if (!isToolSufficient(equipped, activeRequirement)) {
                let toolItem = pickBestInventoryTool(bot, activeRequirement);

                if (!toolItem && autoAcquireRequiredTools) {
                  const needTool = minimumToolName(activeRequirement);
                  if (needTool) {
                    log({
                      type: "gather_tool_auto_acquire",
                      item,
                      block: normalizeItemName(digBlock.name),
                      needTool
                    });
                    const ensured = await ensureItem(bot, needTool, 1, cfg, runCtx, log, { tableBlock: null });
                    if (!ensured.ok) {
                      log({
                        type: "gather_tool_missing",
                        item,
                        block: normalizeItemName(digBlock.name),
                        needTool
                      });
                      return {
                        ok: false,
                        code: "missing_required_tool",
                        reason: `need ${needTool} for ${normalizeItemName(digBlock.name)}`,
                        nextNeed: `craft ${needTool}`,
                        recoverable: false
                      };
                    }
                    toolItem = pickBestInventoryTool(bot, activeRequirement);
                  }
                }

                if (!toolItem) {
                  const needTool = minimumToolName(activeRequirement) || `${activeRequirement.minTier || "wooden"}_${activeRequirement.toolType}`;
                  log({
                    type: "gather_tool_missing",
                    item,
                    block: normalizeItemName(digBlock.name),
                    needTool
                  });
                  return {
                    ok: false,
                    code: "missing_required_tool",
                    reason: `need ${needTool} for ${normalizeItemName(digBlock.name)}`,
                    nextNeed: `craft ${needTool}`,
                    recoverable: false
                  };
                }

                try {
                  await bot.equip(toolItem, "hand");
                } catch {
                  const needTool = minimumToolName(activeRequirement) || normalizeItemName(toolItem.name);
                  return {
                    ok: false,
                    code: "missing_required_tool",
                    reason: `need ${needTool} for ${normalizeItemName(digBlock.name)}`,
                    nextNeed: `craft ${needTool}`,
                    recoverable: false
                  };
                }
                equipped = normalizeItemName(bot.heldItem?.name || toolItem.name);
                if (!isToolSufficient(equipped, activeRequirement)) {
                  return {
                    ok: false,
                    code: "gather_tool_incompatible",
                    reason: `held tool incompatible for ${normalizeItemName(digBlock.name)}`,
                    nextNeed: `equip ${minimumToolName(activeRequirement) || activeRequirement.toolType}`,
                    recoverable: false
                  };
                }
              }
            }
          }
          await bot.dig(digBlock, true);
        } catch (e) {
          const waitedDigFail = await waitTicks(bot, 4, runCtx);
          if (!waitedDigFail) return { ok: false, status: "cancel" };
          continue;
        }

        const waited = await waitTicks(bot, 2, runCtx);
        if (!waited) return { ok: false, status: "cancel" };
        if (inventoryCount(bot, item) > before) {
          gatheredThisLoop = true;
          reportProgress(runCtx, `gathered ${item}`, {
            stepAction: "gather_block",
            gatherRingIndex: ringIndex + 1,
            attempt
          });
          break;
        }
        if (strictToolGate && activeRequirement) {
          const blockName = normalizeItemName(block.name);
          const needTool = minimumToolName(activeRequirement) || `${activeRequirement.minTier || "wooden"}_${activeRequirement.toolType}`;
          log({
            type: "gather_tool_incompatible",
            item,
            block: blockName,
            needTool
          });
          return {
            ok: false,
            code: "gather_tool_incompatible",
            reason: `need ${needTool} for ${blockName}`,
            nextNeed: `craft ${needTool}`,
            recoverable: false
          };
        }
      }

      if (gatheredThisLoop) break;
    }

    if (!gatheredThisLoop) {
      const fromRadius = maxRing;
      const toRadius = Math.max(fromRadius + 1, Number(cfg.missingResourceExpandedRadius || 120));
      if (String(cfg.missingResourcePolicy || "ask_before_move").toLowerCase() === "ask_before_move") {
        return {
          ok: false,
          code: "confirm_expand_search",
          reason: `no ${item} source nearby (within ${fromRadius})`,
          nextNeed: `expand search to ${toRadius}`,
          recoverable: false,
          meta: { item, fromRadius, toRadius }
        };
      }
      return {
        ok: false,
        code: "resource_not_loaded",
        reason: `no ${item} source nearby (within ${fromRadius})`,
        nextNeed: `move to area with ${item} source`,
        recoverable: false,
        meta: { item, fromRadius, toRadius }
      };
    }
  }

  return { ok: true, progress: { at: Date.now(), msg: `gathered ${item}` } };
}

async function harvestCropStep(bot, args, cfg, runCtx, log) {
  const item = normalizeItemName(args?.item);
  const count = Math.max(1, Number(args?.count || 1));
  const cropBlocks = Array.isArray(args?.cropBlocks) ? args.cropBlocks.map((n) => normalizeItemName(n)) : [];
  const radius = cfg.autoGatherRadius || cfg.craftGatherRadius || 48;

  while (inventoryCount(bot, item) < count) {
    if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
    const block = bot.findBlock({
      matching: (b) => !!b && cropBlocks.includes(normalizeItemName(b.name)),
      maxDistance: radius
    });
    if (!block) {
      return { ok: false, code: "resource_not_loaded", reason: `no ${item} crops nearby`, nextNeed: `find ${item} crops`, recoverable: true };
    }

    const reached = await moveNearWithReasoning(
      bot,
      block.position,
      2,
      cfg.reasoningStepTimeoutMs || 12000,
      runCtx,
      cfg,
      log,
      "harvest_crop_move"
    );
    if (!reached) return { ok: false, code: "path_blocked", reason: `path blocked to ${item} crop`, nextNeed: "move to open path", recoverable: true };

    try {
      const digBlock = bot.blockAt(block.position);
      if (!digBlock) return { ok: false, code: "resource_not_loaded", reason: `${item} crop vanished`, nextNeed: `find another ${item} crop`, recoverable: true };
      await bot.dig(digBlock, true);
    } catch (e) {
      return { ok: false, code: "path_blocked", reason: `failed harvesting ${item}`, nextNeed: `clear path to ${item} crop`, recoverable: true };
    }
    const waited = await waitTicks(bot, 2, runCtx);
    if (!waited) return { ok: false, status: "cancel" };
  }
  return { ok: true };
}

async function killMobDropStep(bot, args, cfg, runCtx, log) {
  const item = normalizeItemName(args?.item);
  const count = Math.max(1, Number(args?.count || 1));
  const mobs = Array.isArray(args?.mobs) ? args.mobs.map((m) => normalizeItemName(m)) : [];
  const maxDistance = cfg.maxTaskDistance || 32;
  const timeoutMs = (cfg.taskTimeoutSec || 60) * 1000;
  const started = Date.now();

  while (inventoryCount(bot, item) < count) {
    if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
    if (Date.now() - started > timeoutMs) {
      return { ok: false, code: "target_unreachable", reason: `timed out hunting ${item}`, nextNeed: "move closer to mobs", recoverable: true };
    }

    const target = Object.values(bot.entities || {})
      .filter((e) => isLivingNonPlayerEntity(e))
      .map((e) => ({ e, name: normalizeItemName(getCanonicalEntityName(e)) }))
      .filter((row) => mobs.includes(row.name))
      .sort((a, b) => bot.entity.position.distanceTo(a.e.position) - bot.entity.position.distanceTo(b.e.position))[0]?.e || null;

    if (!target || bot.entity.position.distanceTo(target.position) > maxDistance) {
      const waited = await waitTicks(bot, 10, runCtx);
      if (!waited) return { ok: false, status: "cancel" };
      continue;
    }

    const dist = bot.entity.position.distanceTo(target.position);
    if (dist > 3) {
      const reached = await moveNearWithReasoning(
        bot,
        target.position,
        2,
        cfg.reasoningStepTimeoutMs || 12000,
        runCtx,
        cfg,
        log,
        "kill_mob_move"
      );
      if (!reached) return { ok: false, code: "path_blocked", reason: "path blocked to target", nextNeed: "move to open area", recoverable: true };
    }

    try {
      bot.attack(target);
    } catch (e) {
      return { ok: false, code: "target_unreachable", reason: "failed to attack target", nextNeed: "move closer", recoverable: true };
    }
    const waited = await waitTicks(bot, 8, runCtx);
    if (!waited) return { ok: false, status: "cancel" };
  }
  return { ok: true };
}

async function smeltRecipeStep(bot, args, cfg, runCtx, log, ctx) {
  const station = args?.station || "furnace";
  const ensured = await ensureStation(bot, station, cfg, runCtx, log, ctx);
  if (!ensured.ok) return ensured;
  return {
    ok: false,
    code: "unsupported_acquisition",
    reason: `smelting not implemented for ${args?.item || "item"}`,
    nextNeed: `smelt ${args?.item || "item"} manually`,
    recoverable: false
  };
}

function parseGatherRings(cfg = {}) {
  const configured = Array.isArray(cfg.gatherRadiusSteps) && cfg.gatherRadiusSteps.length
    ? cfg.gatherRadiusSteps
    : [cfg.autoGatherRadius || cfg.craftGatherRadius || 48];
  const rings = configured
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  return rings.length ? rings : [48];
}

function estimateGatherStepTimeoutMs(cfg = {}) {
  const rings = parseGatherRings(cfg);
  const retries = Math.max(1, Number(cfg.gatherExpandRetryPerRing || 2));
  const largest = rings[rings.length - 1] || 48;
  const moveEstimate = moveTimeoutForDistance(cfg, largest);
  const perAttempt = moveEstimate + 6000;
  const total = perAttempt * retries * rings.length;
  return Math.min(180000, Math.max(15000, Math.floor(total)));
}

function effectiveStepTimeoutMs(step, cfg = {}) {
  const base = Math.max(1000, Number(step?.timeoutMs || cfg.reasoningStepTimeoutMs || 12000));
  if (step?.action !== "gather_block") return base;
  return Math.max(base, estimateGatherStepTimeoutMs(cfg));
}

async function executeGoalPlan(bot, goalPlan, cfg, runCtx, log, progress = null) {
  if (!goalPlan?.ok || !Array.isArray(goalPlan.steps)) {
    return normalizeCraftResult("fail", "invalid goal plan", "rebuild plan");
  }

  const timeoutSec = goalPlan?.constraints?.timeoutSec || cfg.autoGatherTimeoutSec || cfg.craftJobTimeoutSec || 90;
  const deadline = Date.now() + timeoutSec * 1000;
  const ctx = { stations: {} };

  for (const step of goalPlan.steps) {
    if (isCancelled(runCtx)) return { status: "cancel" };
    if (Date.now() > deadline) return { status: "timeout", reason: "goal timeout", recoverable: false };
    if (typeof runCtx?.setStep === "function") {
      runCtx.setStep(step.id || null, step.action || null, {
        msg: `step ${step.action}`
      });
    }
    if (typeof progress === "function") {
      progress(`step ${step.action}`, {
        stepId: step.id || null,
        stepAction: step.action || null
      });
    }
    reportProgress(runCtx, `step ${step.action}`, {
      stepId: step.id || null,
      stepAction: step.action || null
    });

    log({ type: "need_acquire_start", goalId: goalPlan.goalId, step });
    log({
      type: "step_progress",
      taskId: runCtx?.id || null,
      goalId: goalPlan.goalId,
      stepId: step.id || null,
      action: step.action || null,
      msg: `start ${step.action}`
    });
    const stepRunner = async () => {
      if (step.action === "ensure_station") return ensureStation(bot, step.args?.station, cfg, runCtx, log, ctx);
      if (step.action === "craft_recipe") return craftRecipeStep(bot, step.args, cfg, runCtx, log, ctx);
      if (step.action === "gather_block") return gatherBlockStep(bot, step.args, cfg, runCtx, log);
      if (step.action === "harvest_crop") return harvestCropStep(bot, step.args, cfg, runCtx, log);
      if (step.action === "kill_mob_drop") return killMobDropStep(bot, step.args, cfg, runCtx, log);
      if (step.action === "smelt_recipe") return smeltRecipeStep(bot, step.args, cfg, runCtx, log, ctx);
      return { ok: false, code: "unsupported_step", reason: `unsupported step ${step.action}`, nextNeed: "update planner", recoverable: false };
    };

    const stepTimeoutMs = effectiveStepTimeoutMs(step, cfg);
    let timeoutHandle = null;
    const timeoutResult = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => {
        try {
          bot.pathfinder?.setGoal?.(null);
          bot.clearControlStates?.();
        } catch {}
        log({
          type: "step_timeout",
          taskId: runCtx?.id || null,
          goalId: goalPlan.goalId,
          stepId: step.id || null,
          action: step.action || null
        });
        resolve({
          ok: false,
          code: "step_timeout",
          reason: `step timeout: ${step.action}`,
          nextNeed: "move to open area",
          recoverable: true
        });
      }, stepTimeoutMs);
    });

    const result = await Promise.race([
      runStepWithCorrection(
        step.action,
        stepRunner,
        { bot, cfg, runCtx, log },
        step.retryPolicy || {}
      ),
      timeoutResult
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    if (result?.status === "cancel") return { status: "cancel" };
    if (!result?.ok) {
      log({
        type: "need_acquire_fail",
        goalId: goalPlan.goalId,
        step,
        code: result?.code || "step_failed",
        reason: result?.reason || "step failed",
        nextNeed: result?.nextNeed || null,
        meta: result?.meta || null
      });
      log({
        type: "step_terminal",
        taskId: runCtx?.id || null,
        goalId: goalPlan.goalId,
        stepId: step.id || null,
        action: step.action || null,
        status: "fail",
        code: result?.code || "step_failed",
        reason: result?.reason || "step failed",
        nextNeed: result?.nextNeed || null,
        meta: result?.meta || null
      });
      return {
        status: "fail",
        code: result?.code || "step_failed",
        reason: result?.reason || "step failed",
        nextNeed: result?.nextNeed || null,
        recoverable: !!result?.recoverable,
        meta: result?.meta || null
      };
    }

    log({ type: "need_acquire_ok", goalId: goalPlan.goalId, step: step.action });
    log({
      type: "step_terminal",
      taskId: runCtx?.id || null,
      goalId: goalPlan.goalId,
      stepId: step.id || null,
      action: step.action || null,
      status: "success"
    });
    if (typeof progress === "function") {
      progress(`step ok ${step.action}`, {
        stepId: step.id || null,
        stepAction: step.action || null
      });
    }
    reportProgress(runCtx, `step ok ${step.action}`, {
      stepId: step.id || null,
      stepAction: step.action || null
    });
  }

  if (inventoryCount(bot, goalPlan.item) < goalPlan.count) {
    return {
      status: "fail",
      code: "goal_output_missing",
      reason: `need ${goalPlan.item}`,
      nextNeed: `acquire ${goalPlan.item}`,
      recoverable: false
    };
  }
  return { status: "success" };
}

async function executeCraftPlan(bot, plan, cfg, runCtx, log) {
  const timeoutSec = plan.timeoutSec || cfg.craftJobTimeoutSec || 90;
  const deadline = Date.now() + timeoutSec * 1000;
  const ctx = { tableBlock: null };

  for (const step of plan.steps) {
    if (isCancelled(runCtx)) {
      return normalizeCraftResult("cancel", "craft job cancelled");
    }
    if (Date.now() > deadline) {
      return normalizeCraftResult("timeout", "craft job timeout", "reduce scope or increase timeout");
    }

    log({ type: "craft_step_start", item: plan.item, step });
    let result = { ok: true };

    if (step.action === "ensure_item") {
      result = await ensureItem(bot, step.item, step.count, cfg, runCtx, log, ctx);
    } else if (step.action === "ensure_table") {
      result = await ensureTablePlaced(bot, cfg, runCtx, log);
    } else if (step.action === "gather_log") {
      result = await gatherLogs(bot, step.count, cfg, runCtx, log);
    } else if (step.action === "mine_cobble") {
      result = await mineCobble(bot, step.count, cfg, runCtx, log);
    } else if (step.action === "acquire_pickaxe") {
      result = await ensureItem(bot, "wooden_pickaxe", 1, cfg, runCtx, log, ctx);
    } else if (step.action === "craft") {
      result = await ensureItem(bot, step.item, step.count, cfg, runCtx, log, ctx);
    }

    if (result.status === "cancel") return normalizeCraftResult("cancel", "craft job cancelled");
    if (!result.ok) {
      log({ type: "craft_step_fail", item: plan.item, step, reason: result.reason, nextNeed: result.nextNeed || null });
      return normalizeCraftResult("fail", result.reason || "craft step failed", result.nextNeed || null);
    }

    log({ type: "craft_step_ok", item: plan.item, step: step.action });
  }

  if (inventoryCount(bot, plan.item) < plan.count) {
    return normalizeCraftResult("fail", `need ${plan.item}`, `craft ${plan.item}`);
  }
  return normalizeCraftResult("success", `crafted ${plan.item} x${plan.count}`);
}

module.exports = {
  executeCraftPlan,
  executeGoalPlan,
  inventoryCount,
  __test: {
    ensureTablePlaced,
    gatherLogs,
    mineCobble,
    gatherBlockStep,
    moveNear,
    moveNearWithReasoning,
    makeFail,
    moveTimeoutForDistance,
    selectBestCraftRecipe
  }
};
