const { goals, Movements } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");
const { CRAFT_GRAPH } = require("./craft_planner");
const { getCanonicalEntityName, isLivingNonPlayerEntity } = require("./entities");
const { refreshNearbyStationInventory } = require("./knowledge");
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
const { fuelPlan, findFuelInventoryItem, fuelSmeltValue, requiredFuelItemCount } = require("./fuel_planner");
const { autoRelocateForResource } = require("./resource_navigator");
const { moveNearHuman, applyMovementProfile } = require("./motion_controller");
const { buildGoalPlan } = require("./dependency_planner");

function normalizeItemName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/^minecraft:/, "")
    .trim();
}

function toBlockPos(pos) {
  if (!pos) return null;
  if (typeof pos.floored === "function") return pos.floored();
  const x = Number(pos.x);
  const y = Number(pos.y);
  const z = Number(pos.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
}

function offsetBlockPos(pos, dx, dy, dz) {
  if (!pos) return null;
  if (typeof pos.offset === "function") return pos.offset(dx, dy, dz);
  const base = toBlockPos(pos);
  if (!base) return null;
  return base.offset(dx, dy, dz);
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

function isSolidBlock(block) {
  return !!block && block.boundingBox === "block";
}

function isEmptyBlock(block) {
  return !block || block.boundingBox === "empty";
}

const HAZARDOUS_STAND_BLOCKS = new Set([
  "water",
  "lava",
  "fire",
  "soul_fire",
  "campfire",
  "soul_campfire",
  "cactus",
  "sweet_berry_bush",
  "magma_block"
]);

function isLogLikeBlockName(name) {
  return /(_log|_stem|_hyphae)$/.test(normalizeItemName(name));
}

function isLeafLikeBlockName(name) {
  return /_leaves$/.test(normalizeItemName(name));
}

function isHazardousStandBlock(block) {
  const name = normalizeItemName(block?.name || "");
  return HAZARDOUS_STAND_BLOCKS.has(name);
}

function listInventoryItems(bot) {
  if (!bot?.inventory) return [];
  if (typeof bot.inventory.items === "function") {
    const listed = bot.inventory.items();
    if (Array.isArray(listed)) return listed;
  }
  const fromSlots = Array.isArray(bot.inventory.slots)
    ? bot.inventory.slots.filter(Boolean)
    : [];
  if (fromSlots.length > 0) return fromSlots;
  return [];
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

function normalizeProgressKind(value) {
  const kind = String(value || "").toLowerCase().trim();
  return kind === "heartbeat" ? "heartbeat" : "state";
}

function isStateProgress(extra = {}) {
  return normalizeProgressKind(extra?.progressKind) === "state";
}

function reportProgress(runCtx, message, extra = {}) {
  try {
    if (typeof runCtx?.reportProgress === "function") {
      runCtx.reportProgress(message, extra);
    }
  } catch {}
}

function stepTargetInventoryCount(bot, item, count) {
  const needed = Math.max(1, Number(count || 1));
  return inventoryCount(bot, item) + needed;
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

function timeoutsDisabled(cfg = {}) {
  return cfg?.disableTimeouts === true;
}

function configuredStationSearchRadius(cfg = {}) {
  return Math.max(8, Number(cfg.stationSearchRadius || 32));
}

function findNearbyCraftingTable(bot, radius = 6) {
  const mcData = require("minecraft-data")(bot.version);
  const id = mcData.blocksByName?.crafting_table?.id;
  if (!id) return null;
  return bot.findBlock({ matching: id, maxDistance: radius });
}

async function moveNear(bot, position, radius, timeoutMs, runCtx) {
  const result = await moveNearHuman(
    bot,
    position,
    radius,
    timeoutMs,
    runCtx,
    bot.__runtimeCfg || {},
    () => {},
    "craft_move"
  );
  if (result.status === "success") return true;
  return false;
}

async function moveToExactBlock(bot, position, timeoutMs, runCtx) {
  bot.pathfinder.setGoal(new goals.GoalBlock(position.x, position.y, position.z));
  const start = Date.now();
  let lastProgressBeat = 0;
  while (Date.now() - start < timeoutMs) {
    if (isCancelled(runCtx)) return false;
    const feet = bot.entity.position.floored();
    const now = Date.now();
    if (now - lastProgressBeat >= 2000) {
      const dx = position.x - feet.x;
      const dy = position.y - feet.y;
      const dz = position.z - feet.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      reportProgress(runCtx, `repositioning (${dist.toFixed(1)}m)`, {
        stepAction: runCtx?.currentStepAction || "move",
        distance: Number(dist.toFixed(2))
      });
      lastProgressBeat = now;
    }
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
  applyMovementProfile(bot, cfg, log);
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
  const stationRadius = configuredStationSearchRadius(cfg);
  let table = findNearbyCraftingTable(bot, stationRadius);
  if (table) {
    log({ type: "craft_step_ok", action: "ensure_table", reused: true });
    return { ok: true, table };
  }

  await retrieveNearbyStationItems(bot, "crafting_table", 1, cfg, runCtx, log);
  if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
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
    const resolved = table || findNearbyCraftingTable(bot, stationRadius);
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
  const stationRadius = configuredStationSearchRadius(cfg);
  let table = findNearbyCraftingTable(bot, stationRadius);
  if (table) {
    log({ type: "craft_step_ok", action: "ensure_table", reused: true });
    return { ok: true, table };
  }
  if (!cfg.craftAutoPlaceTable) {
    return makeFail("need crafting table nearby", "place crafting table", false, "missing_table");
  }
  await retrieveNearbyStationItems(bot, "crafting_table", 1, cfg, runCtx, log);
  if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
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
    await retrieveNearbyStationItems(bot, "crafting_table", 1, cfg, runCtx, log);
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
    table = findNearbyCraftingTable(bot, stationRadius);
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
    const nearby = findNearbyCraftingTable(bot, stationRadius);
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
    return { ok: true, table: result.table || findNearbyCraftingTable(bot, stationRadius) };
  }
  return makeFail(
    result?.reason || "failed to place crafting table",
    result?.nextNeed || "clear placement space",
    false,
    result?.code || "ensure_table_failed"
  );
}

async function placeStationFromInventory(bot, station, cfg, runCtx, log) {
  const stationName = normalizeItemName(station);
  const stationRadius = configuredStationSearchRadius(cfg);
  if (!stationName || stationName === "inventory") return { ok: true, stationBlock: null };
  const nearby = findNearbyStation(bot, stationName, stationRadius);
  if (nearby) return { ok: true, stationBlock: nearby };

  const placeAttempt = async () => {
    if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
    await retrieveNearbyStationItems(bot, stationName, 1, cfg, runCtx, log);
    if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
    const placeItem = findInventoryItem(bot, stationName);
    if (!placeItem) {
      return makeFail(`need ${stationName} item`, `craft ${stationName}`, false, "missing_station_item");
    }

    const candidate = findPlacementCandidate(bot, { cfg, log });
    if (!candidate) {
      return makeFail(
        `failed to place ${stationName}`,
        "clear placement space near bot",
        false,
        "no_valid_placement_candidate"
      );
    }

    const moved = await moveToExactBlock(
      bot,
      candidate.standPos,
      cfg.reasoningMoveTimeoutMs || 12000,
      runCtx
    );
    if (!moved) {
      return makeFail(
        `failed to place ${stationName}`,
        "clear path for placement",
        true,
        "placement_stand_unreachable"
      );
    }
    if (isCancelled(runCtx)) return { ok: false, status: "cancel" };

    const feet = bot.entity.position.floored();
    if (feet.x === candidate.tablePos.x && feet.y === candidate.tablePos.y && feet.z === candidate.tablePos.z) {
      return makeFail(
        `failed to place ${stationName}`,
        "step off target block",
        true,
        "standing_in_target_cell"
      );
    }

    const reference = bot.blockAt(candidate.tablePos.offset(0, -1, 0));
    if (!reference || reference.boundingBox !== "block") {
      return makeFail(`failed to place ${stationName}`, "clear placement space", true, "invalid_support");
    }

    try {
      await bot.equip(placeItem, "hand");
      await bot.placeBlock(reference, { x: 0, y: 1, z: 0 });
    } catch (e) {
      const detail = String(e?.message || e || "");
      const recoverable = /(blocked|occup|space|entity|interact|range|position|path)/i.test(detail);
      return makeFail(
        `failed to place ${stationName}`,
        recoverable ? "clear placement space" : "move to open area",
        recoverable,
        "place_exception"
      );
    }

    const waited = await waitTicks(bot, 2, runCtx);
    if (!waited) return { ok: false, status: "cancel" };
    const nearbyAfter = findNearbyStation(bot, stationName, stationRadius);
    if (nearbyAfter) return { ok: true, stationBlock: nearbyAfter };
    return makeFail(`failed to place ${stationName}`, "clear placement space", true, "station_not_found_after_place");
  };

  if (!reasoningEnabled(cfg)) {
    return placeAttempt();
  }

  const result = await runWithSelfCorrection(
    `ensure_${stationName}_placed`,
    placeAttempt,
    {},
    { bot, cfg, runCtx, log }
  );
  if (result?.status === "cancel") return { ok: false, status: "cancel" };
  if (result?.ok) return { ok: true, stationBlock: result.stationBlock || findNearbyStation(bot, stationName, stationRadius) };
  return makeFail(
    result?.reason || `failed to place ${stationName}`,
    result?.nextNeed || `place ${stationName}`,
    false,
    result?.code || "ensure_station_failed"
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

const LOG_BLOCK_NAMES = [
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

async function gatherLogs(bot, needed, cfg, runCtx, log) {
  while (inventoryCount(bot, "log") < needed) {
    if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
    const missing = Math.max(1, needed - inventoryCount(bot, "log"));
    const result = await gatherBlockStep(
      bot,
      {
        item: "log",
        count: missing,
        blockNames: [...LOG_BLOCK_NAMES],
        preferredBlocks: [...LOG_BLOCK_NAMES]
      },
      cfg,
      runCtx,
      log
    );
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
  const pick = pickBestInventoryTool(bot, {
    toolType: "pickaxe",
    minTier: "wooden"
  });
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
  const pulled = await retrieveNearbyStationItems(bot, item, count, cfg, runCtx, log);
  if (pulled?.status === "cancel") return pulled;
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
  if (!node) {
    if (cfg?.dependencyPlannerEnabled === false || cfg?.intelligenceEnabled === false) {
      return {
        ok: false,
        reason: `unsupported craft item ${item}`,
        nextNeed: "supported wood/stone item"
      };
    }

    const ensureStack = ctx?.ensureStack instanceof Set ? ctx.ensureStack : new Set();
    if (ctx && !(ctx.ensureStack instanceof Set)) ctx.ensureStack = ensureStack;
    const ensureKey = `${normalizeItemName(item)}:${Math.max(1, Number(count || 1))}`;
    if (ensureStack.has(ensureKey)) {
      return {
        ok: false,
        code: "ensure_item_cycle",
        reason: `cyclic ensure for ${item}`,
        nextNeed: `review dependency plan for ${item}`,
        recoverable: false
      };
    }

    ensureStack.add(ensureKey);
    try {
      const deficit = Math.max(1, Number(count || 1) - inventoryCount(bot, item));
      const subIntent = {
        type: "craftItem",
        item,
        count,
        goalId: `${runCtx?.goalId || "ensure"}_${normalizeItemName(item)}_${Date.now()}`
      };
      const subPlan = buildGoalPlan(bot, subIntent, cfg, null, log);
      if (!subPlan?.ok) {
        return normalizeStepResult(subPlan, "ensure_item_subplan_failed");
      }
      const subRunCtx = {
        ...runCtx,
        goalId: subPlan.goalId || runCtx?.goalId || null
      };
      log({
        type: "ensure_item_subplan_start",
        item,
        count: deficit,
        goalId: subPlan.goalId || null
      });
      const subResult = await executeGoalPlan(bot, subPlan, cfg, subRunCtx, log);
      if (subResult?.status === "cancel") return { ok: false, status: "cancel" };
      if (subResult?.status === "timeout") {
        return {
          ok: false,
          code: "ensure_item_subplan_timeout",
          reason: `timed out acquiring ${item}`,
          nextNeed: `retry ${item}`,
          recoverable: false
        };
      }
      if (inventoryCount(bot, item) >= count) return { ok: true };
      return {
        ok: false,
        code: subResult?.code || "ensure_item_subplan_failed",
        reason: subResult?.reason || `failed acquiring ${item}`,
        nextNeed: subResult?.nextNeed || `acquire ${item}`,
        recoverable: !!subResult?.recoverable
      };
    } finally {
      ensureStack.delete(ensureKey);
    }
  }

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
  const stationName = normalizeItemName(station);
  const allowedStations = Array.isArray(cfg.stationExecutionEnabled) && cfg.stationExecutionEnabled.length
    ? cfg.stationExecutionEnabled.map((s) => normalizeItemName(s))
    : (Array.isArray(cfg.supportedStations) && cfg.supportedStations.length
      ? cfg.supportedStations.map((s) => normalizeItemName(s))
      : ["inventory", "crafting_table", "furnace", "smoker", "blast_furnace", "stonecutter", "smithing_table"]);
  if (!allowedStations.includes(stationName)) {
    return {
      ok: false,
      code: "station_not_supported",
      reason: `station ${stationName} not enabled`,
      nextNeed: "enable stationExecutionEnabled",
      recoverable: false
    };
  }

  const stationRadius = configuredStationSearchRadius(cfg);
  const moveToStation = async (stationName, stationBlock) => {
    if (!stationBlock?.position) return { ok: false, code: "station_unavailable", reason: `need ${stationName} nearby`, nextNeed: `place ${stationName}`, recoverable: false };
    const dist = bot.entity?.position?.distanceTo?.(stationBlock.position);
    if (!Number.isFinite(dist) || dist <= 4.5) return { ok: true };
    const reached = await moveNearWithReasoning(
      bot,
      stationBlock.position,
      2,
      moveTimeoutForDistance(cfg, dist),
      runCtx,
      cfg,
      log,
      "station_move"
    );
    if (!reached) {
      return {
        ok: false,
        code: "path_blocked",
        reason: `path blocked to ${stationName}`,
        nextNeed: `move near ${stationName}`,
        recoverable: true
      };
    }
    return { ok: true };
  };

  if (stationName === "crafting_table") {
    let tableRes = await ensureTablePlaced(bot, cfg, runCtx, log);
    if (!tableRes.ok && tableRes.code === "missing_table_item") {
      log({
        type: "station_auto_acquire",
        station: "crafting_table",
        reason: tableRes.reason || "missing station item"
      });
      const ensuredTableItem = await ensureItem(
        bot,
        "crafting_table",
        inventoryCount(bot, "crafting_table") + 1,
        cfg,
        runCtx,
        log,
        ctx
      );
      const normalized = normalizeStepResult(ensuredTableItem, "station_item_auto_acquire_failed");
      if (normalized.status === "cancel") return normalized;
      if (!normalized.ok) return normalized;
      tableRes = await ensureTablePlaced(bot, cfg, runCtx, log);
    }
    if (!tableRes.ok) return normalizeStepResult(tableRes, "station_unavailable");
    const moved = await moveToStation("crafting_table", tableRes.table);
    if (!moved.ok) return moved;
    ctx.stations.crafting_table = tableRes.table;
    return { ok: true, data: tableRes.table };
  }

  const existing = findNearbyStation(bot, stationName, stationRadius);
  if (existing) {
    const moved = await moveToStation(stationName, existing);
    if (!moved.ok) return moved;
    ctx.stations[stationName] = existing;
    return { ok: true, data: existing };
  }

  let placed = await placeStationFromInventory(bot, stationName, cfg, runCtx, log);
  if (!placed?.ok && placed?.code === "missing_station_item") {
    log({
      type: "station_auto_acquire",
      station: stationName,
      reason: placed.reason || "missing station item"
    });
    const ensuredStationItem = await ensureItem(
      bot,
      stationName,
      inventoryCount(bot, stationName) + 1,
      cfg,
      runCtx,
      log,
      ctx
    );
    const normalized = normalizeStepResult(ensuredStationItem, "station_item_auto_acquire_failed");
    if (normalized.status === "cancel") return normalized;
    if (!normalized.ok) return normalized;
    placed = await placeStationFromInventory(bot, stationName, cfg, runCtx, log);
  }
  if (placed?.status === "cancel") return { ok: false, status: "cancel" };
  if (!placed?.ok) {
    return {
      ok: false,
      code: placed.code || "station_unavailable",
      reason: placed.reason || `need ${stationName} nearby`,
      nextNeed: placed.nextNeed || `place ${stationName}`,
      recoverable: !!placed.recoverable
    };
  }
  if (placed.stationBlock) {
    const moved = await moveToStation(stationName, placed.stationBlock);
    if (!moved.ok) return moved;
    ctx.stations[stationName] = placed.stationBlock;
  }
  return { ok: true, data: placed.stationBlock || findNearbyStation(bot, stationName, stationRadius) };
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

function stationInventorySnapshot(bot) {
  const out = {};
  const counts = bot?.__stationInventoryCache?.counts || {};
  for (const [name, rawCount] of Object.entries(counts)) {
    const key = normalizeItemName(name);
    const count = Number(rawCount || 0);
    if (!key || !Number.isFinite(count) || count <= 0) continue;
    out[key] = (out[key] || 0) + count;
  }
  return out;
}

function availableInventorySnapshot(bot) {
  const carried = inventorySnapshot(bot);
  const station = stationInventorySnapshot(bot);
  const merged = { ...carried };
  for (const [name, count] of Object.entries(station)) {
    merged[name] = Number(merged[name] || 0) + Number(count || 0);
  }
  return merged;
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

function blockPosKey(pos) {
  if (!pos) return "";
  return `${pos.x}|${pos.y}|${pos.z}`;
}

function standSpotsAroundBlock(block) {
  if (!block?.position) return [];
  const out = [];
  const seen = new Set();
  for (const yOffset of [-2, -1, 0, 1, 2]) {
    for (let x = -2; x <= 2; x += 1) {
      for (let z = -2; z <= 2; z += 1) {
        const pos = block.position.offset(x, yOffset, z).floored();
        const key = blockPosKey(pos);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(pos);
      }
    }
  }
  return out;
}

function evaluateStandSpot(bot, block, feetPos, options = {}) {
  const reasons = [];
  const below = bot.blockAt(feetPos.offset(0, -1, 0));
  const feet = bot.blockAt(feetPos);
  const head = bot.blockAt(feetPos.offset(0, 1, 0));
  const belowName = normalizeItemName(below?.name || "");
  if (!isSolidBlock(below)) reasons.push("no_support");
  if (isHazardousStandBlock(below)) reasons.push("hazard_support");
  if (isHazardousStandBlock(feet)) reasons.push("hazard_feet");
  if (isHazardousStandBlock(head)) reasons.push("hazard_head");
  if (!isEmptyBlock(feet)) reasons.push("blocked_feet");
  if (!isEmptyBlock(head)) reasons.push("blocked_head");
  if (options.rejectLogOrLeavesSupport === true && isLogLikeBlockName(belowName)) reasons.push("log_support");
  if (options.rejectLogOrLeavesSupport === true && isLeafLikeBlockName(belowName)) reasons.push("leaves_support");
  const safe = reasons.length === 0;
  const dist = bot.entity.position.distanceTo(feetPos);
  const yDelta = Math.abs(Number(feetPos?.y || 0) - Number(bot.entity?.position?.y || 0));
  const pickupSafe = safe && feetPos.distanceTo(block.position) <= 2.6;
  const unsafeReasons = pickupSafe ? [] : (safe ? ["pickup_distance"] : reasons);
  return {
    standPos: feetPos,
    standDistance: dist,
    safe,
    pickupSafe,
    unsafeReasons,
    score: dist + yDelta * 3 + (pickupSafe ? 0 : 18)
  };
}

function selectBestStandSpot(bot, block, options = {}) {
  const spots = standSpotsAroundBlock(block);
  let best = null;
  for (const feetPos of spots) {
    const evaluated = evaluateStandSpot(bot, block, feetPos, options);
    if (!evaluated.safe) continue;
    if (!best || evaluated.score < best.score) best = evaluated;
  }
  return best || null;
}

function hasAdjacentStandSpot(bot, block, options = {}) {
  const stand = selectBestStandSpot(bot, block, options);
  return !!stand && stand.pickupSafe === true;
}

function manhattanDistance(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.abs(Number(a.x || 0) - Number(b.x || 0))
    + Math.abs(Number(a.y || 0) - Number(b.y || 0))
    + Math.abs(Number(a.z || 0) - Number(b.z || 0));
}

function orthogonalNeighbors(pos) {
  return [
    offsetBlockPos(pos, 1, 0, 0),
    offsetBlockPos(pos, -1, 0, 0),
    offsetBlockPos(pos, 0, 1, 0),
    offsetBlockPos(pos, 0, -1, 0),
    offsetBlockPos(pos, 0, 0, 1),
    offsetBlockPos(pos, 0, 0, -1)
  ].filter(Boolean);
}

function buildConnectedLogCluster(bot, seedBlock, matchSet, options = {}) {
  if (!seedBlock?.position || !(matchSet instanceof Set) || matchSet.size === 0) {
    return { treeId: null, positions: [] };
  }
  const seed = toBlockPos(seedBlock.position);
  if (!seed) return { treeId: null, positions: [] };
  const maxNodes = Math.max(1, Number(options.maxNodes || 24));
  const maxManhattanDistance = Math.max(1, Number(options.maxManhattanDistance || 8));
  const queue = [seed];
  const visited = new Set();
  const positions = [];

  while (queue.length && positions.length < maxNodes) {
    const pos = queue.shift();
    const key = blockPosKey(pos);
    if (!key || visited.has(key)) continue;
    visited.add(key);
    if (manhattanDistance(seed, pos) > maxManhattanDistance) continue;
    const block = bot.blockAt(pos);
    if (!block || !matchSet.has(normalizeItemName(block.name))) continue;
    const normalizedPos = toBlockPos(pos);
    if (!normalizedPos) continue;
    positions.push(normalizedPos);
    for (const next of orthogonalNeighbors(pos)) {
      const nextKey = blockPosKey(next);
      if (!nextKey || visited.has(nextKey)) continue;
      const normalizedNext = toBlockPos(next);
      if (!normalizedNext) continue;
      queue.push(normalizedNext);
    }
  }

  const keys = positions.map((pos) => blockPosKey(pos)).filter(Boolean).sort();
  return {
    treeId: keys[0] || blockPosKey(seed),
    positions
  };
}

function positionKeySet(positions = []) {
  const out = new Set();
  for (const pos of positions) {
    const key = blockPosKey(pos);
    if (key) out.add(key);
  }
  return out;
}

function mergeTreePositions(...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const pos of group) {
      const key = blockPosKey(pos);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(pos);
    }
  }
  return out;
}

function makeTreeRecord(treeId, positions = []) {
  const merged = mergeTreePositions(positions);
  return {
    treeId: treeId || null,
    positions: merged,
    positionKeys: positionKeySet(merged)
  };
}

function treeRecordsOverlap(a, b) {
  if (!a?.positionKeys || !b?.positionKeys) return false;
  const [smaller, larger] = a.positionKeys.size <= b.positionKeys.size
    ? [a.positionKeys, b.positionKeys]
    : [b.positionKeys, a.positionKeys];
  for (const key of smaller) {
    if (larger.has(key)) return true;
  }
  return false;
}

function normalizeTreeInfo(treeInfo, treeHints = []) {
  const current = makeTreeRecord(treeInfo?.treeId || null, treeInfo?.positions || []);
  for (const hint of treeHints) {
    if (!hint?.treeId) continue;
    const normalizedHint = hint.positionKeys instanceof Set
      ? hint
      : makeTreeRecord(hint.treeId, hint.positions || []);
    if (treeRecordsOverlap(current, normalizedHint)) {
      return makeTreeRecord(
        normalizedHint.treeId,
        mergeTreePositions(normalizedHint.positions || [], current.positions || [])
      );
    }
  }
  return current;
}

function ringOffsets(ring) {
  if (ring <= 0) return [{ dx: 0, dz: 0 }];
  const out = [];
  for (let i = -ring; i <= ring; i += 1) {
    out.push({ dx: i, dz: -ring });
    out.push({ dx: i, dz: ring });
    if (i !== -ring && i !== ring) {
      out.push({ dx: -ring, dz: i });
      out.push({ dx: ring, dz: i });
    }
  }
  return out;
}

function closestStandDistance(bot, block) {
  const selected = selectBestStandSpot(bot, block);
  return selected ? selected.standDistance : Number.POSITIVE_INFINITY;
}

function localScanCandidates(bot, matchSet, maxDistance, limit = 96) {
  if (!bot?.entity?.position) return [];
  const out = [];
  const seen = new Set();
  const center = bot.entity.position.floored();
  // Keep local scan truly local so ring expansion still controls wider search.
  const localRadius = Math.max(1, Math.min(Number(maxDistance || 8), 6));
  const yOffsets = [0, -1, 1, -2, 2, 3, -3];

  for (let ring = 0; ring <= localRadius; ring += 1) {
    const offsets = ringOffsets(ring);
    for (const y of yOffsets) {
      for (const off of offsets) {
        const pos = center.offset(off.dx, y, off.dz);
        const key = `${pos.x}|${pos.y}|${pos.z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const block = bot.blockAt(pos);
        if (!block) continue;
        if (!matchSet.has(normalizeItemName(block.name))) continue;
        out.push(block);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

function localBlockSummary(bot, radius = 4, maxNames = 8) {
  if (!bot?.entity?.position) return [];
  const center = bot.entity.position.floored();
  const counts = new Map();
  for (let y = -1; y <= 2; y += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      for (let z = -radius; z <= radius; z += 1) {
        const b = bot.blockAt(center.offset(x, y, z));
        const name = normalizeItemName(b?.name || "");
        if (!name || name === "air" || name === "cave_air" || name === "void_air") continue;
        counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxNames)
    .map(([name, count]) => `${name}:${count}`);
}

function gatherSourceLabel(item, blockNames = []) {
  const normalized = Array.isArray(blockNames)
    ? blockNames.map((n) => normalizeItemName(n)).filter(Boolean)
    : [];
  if (item === "cobblestone" && normalized.includes("stone")) {
    return "stone/cobblestone";
  }
  return item;
}

function isItemDropEntity(entity) {
  if (!entity || !entity.position) return false;
  const name = normalizeItemName(entity.name || entity.displayName || entity.username || "");
  const display = normalizeItemName(entity.displayName || "");
  if (name === "item") return true;
  if (display === "item") return true;
  if (String(entity.type || "").toLowerCase() === "object") return true;
  return false;
}

function entityItemNames(entity) {
  const out = new Set();
  const pushName = (value) => {
    const normalized = normalizeItemName(value);
    if (normalized) out.add(normalized);
  };
  pushName(entity?.item?.name);
  pushName(entity?.item?.displayName);
  pushName(entity?.objectData?.name);
  if (Array.isArray(entity?.metadata)) {
    for (const entry of entity.metadata) {
      if (!entry) continue;
      if (typeof entry === "string") pushName(entry);
      if (typeof entry === "object") {
        pushName(entry.name);
        pushName(entry.displayName);
        pushName(entry.item?.name);
      }
    }
  }
  return Array.from(out.values());
}

function scanNearbyDropEntities(bot, centerPos, maxDistance = 5, expectedItem = null) {
  if (!bot?.entities || !centerPos) {
    return {
      count: 0,
      totalCount: 0,
      typedCount: 0,
      nearest: null,
      nearestDistance: Number.POSITIVE_INFINITY,
      hasTypedMatch: false
    };
  }
  const maxDist = Math.max(1, Number(maxDistance || 5));
  const drops = Object.values(bot.entities)
    .filter((entity) => isItemDropEntity(entity))
    .map((entity) => ({
      entity,
      centerDistance: entity.position.distanceTo(centerPos),
      botDistance: bot.entity?.position?.distanceTo?.(entity.position) ?? Number.POSITIVE_INFINITY,
      itemNames: entityItemNames(entity)
    }))
    .filter((row) => Number.isFinite(row.centerDistance) && row.centerDistance <= maxDist)
    .sort((a, b) => a.botDistance - b.botDistance);
  const typed = expectedItem
    ? drops.filter((row) => row.itemNames.some((name) => inventoryMatchesKey(name, expectedItem)))
    : drops;
  const hasTypedMetadata = drops.some((row) => Array.isArray(row.itemNames) && row.itemNames.length > 0);
  const preferred = expectedItem
    ? (typed.length > 0 ? typed : (hasTypedMetadata ? [] : drops))
    : drops;
  return {
    count: preferred.length,
    totalCount: drops.length,
    typedCount: typed.length,
    nearest: preferred[0]?.entity || null,
    nearestDistance: Number.isFinite(preferred[0]?.botDistance) ? preferred[0].botDistance : Number.POSITIVE_INFINITY,
    hasTypedMatch: typed.length > 0
  };
}

async function refreshStationInventoryCache(bot, cfg, log) {
  try {
    return await refreshNearbyStationInventory(bot, cfg, log);
  } catch {
    return bot?.__stationInventoryCache || { counts: {}, sources: [] };
  }
}

function stationSourceMatchesItem(source, item) {
  return inventoryMatchesKey(source?.itemName, item);
}

function stationSourceDistance(bot, source) {
  const pos = toBlockPos(source?.position);
  if (!pos || !bot?.entity?.position?.distanceTo) return Number.POSITIVE_INFINITY;
  return bot.entity.position.distanceTo(pos);
}

function pruneStationInventoryCache(bot) {
  const cache = bot?.__stationInventoryCache;
  if (!cache || typeof cache !== "object") return;
  const counts = {};
  const sources = [];
  for (const source of Array.isArray(cache.sources) ? cache.sources : []) {
    const itemName = normalizeItemName(source?.itemName);
    const count = Number(source?.count || 0);
    if (!itemName || !Number.isFinite(count) || count <= 0) continue;
    sources.push(source);
    counts[itemName] = (counts[itemName] || 0) + count;
  }
  cache.sources = sources;
  cache.counts = counts;
  cache.refreshedAt = Date.now();
}

function noteStationInventoryTransfer(bot, source, movedCount) {
  const moved = Math.max(0, Number(movedCount || 0));
  if (!bot?.__stationInventoryCache || !source || moved <= 0) return;
  source.count = Math.max(0, Number(source.count || 0) - moved);
  pruneStationInventoryCache(bot);
}

async function takeFromStationSource(bot, source, needCount, cfg, runCtx, log) {
  const stationType = normalizeItemName(source?.stationType || "");
  const position = toBlockPos(source?.position);
  if (!stationType || !position) {
    return { ok: false, code: "station_source_invalid", reason: "invalid station source" };
  }

  const distance = stationSourceDistance(bot, source);
  if (Number.isFinite(distance) && distance > 4.5) {
    const moved = await moveNearWithReasoning(
      bot,
      position,
      2,
      moveTimeoutForDistance(cfg, distance),
      runCtx,
      cfg,
      log,
      "station_inventory_move"
    );
    if (!moved) {
      return { ok: false, code: "path_blocked", reason: `path blocked to ${stationType}` };
    }
  }

  const block = bot.blockAt?.(position) || { position, name: stationType, boundingBox: "block" };
  if (stationType === "furnace" || stationType === "smoker" || stationType === "blast_furnace") {
    if (typeof bot.openFurnace !== "function") {
      return { ok: false, code: "station_open_failed", reason: `failed opening ${stationType}` };
    }
    let furnace = null;
    try {
      furnace = await bot.openFurnace(block);
      const slotReader = source.slot === "output"
        ? () => furnace.outputItem?.()
        : (source.slot === "input"
          ? () => furnace.inputItem?.()
          : (source.slot === "fuel" ? () => furnace.fuelItem?.() : null));
      const beforeSlot = slotReader?.() || null;
      const beforeSlotCount = Math.max(0, Number(beforeSlot?.count || 0));
      if (source.slot === "output" && typeof furnace.takeOutput === "function") {
        await furnace.takeOutput();
      } else if (source.slot === "input" && typeof furnace.takeInput === "function") {
        await furnace.takeInput();
      } else if (source.slot === "fuel" && typeof furnace.takeFuel === "function") {
        await furnace.takeFuel();
      } else {
        return { ok: false, code: "station_take_unsupported", reason: `can't take ${source.slot || "slot"} from ${stationType}` };
      }
      const afterSlot = slotReader?.() || null;
      const afterSlotCount = Math.max(0, Number(afterSlot?.count || 0));
      const movedBySlot = Math.max(0, beforeSlotCount - afterSlotCount);
      const movedFallback = Math.max(
        1,
        Math.min(Math.max(1, Number(needCount || 1)), Math.max(1, Number(source?.count || beforeSlotCount || 1)))
      );
      return { ok: true, moved: movedBySlot > 0 ? movedBySlot : movedFallback };
    } catch (error) {
      return { ok: false, code: "station_take_failed", reason: String(error?.message || error || `failed taking from ${stationType}`) };
    } finally {
      try {
        furnace?.close?.();
      } catch {}
    }
  }

  let container = null;
  try {
    if (typeof bot.openChest === "function") {
      try {
        container = await bot.openChest(block);
      } catch {}
    }
    if (!container && typeof bot.openContainer === "function") {
      container = await bot.openContainer(block);
    }
    if (!container || typeof container.withdraw !== "function") {
      return { ok: false, code: "station_open_failed", reason: `failed opening ${stationType}` };
    }
    const withdrawCount = Math.max(1, Math.min(Number(needCount || 1), Number(source.count || 0)));
    await container.withdraw(source.itemType, source.metadata ?? null, withdrawCount);
    return { ok: true, moved: withdrawCount };
  } catch (error) {
    return { ok: false, code: "station_withdraw_failed", reason: String(error?.message || error || `failed withdrawing from ${stationType}`) };
  } finally {
    try {
      container?.close?.();
    } catch {}
  }
}

async function waitForInventoryGain(bot, item, baselineCount, runCtx, maxAttempts = 10) {
  let gained = Math.max(0, inventoryCount(bot, item) - baselineCount);
  for (let i = 0; gained <= 0 && i < Math.max(1, Number(maxAttempts || 1)); i += 1) {
    if (isCancelled(runCtx)) return { status: "cancel", gained: 0 };
    const waited = await waitTicks(bot, 2, runCtx);
    if (!waited) return { status: "cancel", gained: 0 };
    gained = Math.max(0, inventoryCount(bot, item) - baselineCount);
  }
  return { status: "ok", gained };
}

async function retrieveNearbyStationItems(bot, item, targetCount, cfg, runCtx, log) {
  const normalizedItem = normalizeItemName(item);
  if (!normalizedItem || inventoryCount(bot, normalizedItem) >= targetCount) {
    return { ok: true, gained: 0 };
  }

  await refreshStationInventoryCache(bot, cfg, log);
  const sources = (Array.isArray(bot?.__stationInventoryCache?.sources) ? bot.__stationInventoryCache.sources : [])
    .filter((source) => stationSourceMatchesItem(source, normalizedItem))
    .sort((a, b) => stationSourceDistance(bot, a) - stationSourceDistance(bot, b));
  if (!sources.length) return { ok: true, gained: 0 };

  let gainedTotal = 0;
  for (const source of sources) {
    if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
    const needed = Math.max(0, targetCount - inventoryCount(bot, normalizedItem));
    if (needed <= 0) break;
    const before = inventoryCount(bot, normalizedItem);
    const taken = await takeFromStationSource(bot, source, needed, cfg, runCtx, log);
    if (taken?.status === "cancel") return taken;
    if (!taken?.ok) continue;
    const waited = await waitTicks(bot, 2, runCtx);
    if (!waited) return { ok: false, status: "cancel" };
    const after = inventoryCount(bot, normalizedItem);
    const inferredMoved = Math.max(0, Number(taken?.moved || 0));
    let gained = Math.max(0, after - before);
    if (gained <= 0 && inferredMoved > 0) {
      const awaitedGain = await waitForInventoryGain(bot, normalizedItem, before, runCtx, 10);
      if (awaitedGain?.status === "cancel") return { ok: false, status: "cancel" };
      gained = Math.max(0, Number(awaitedGain?.gained || 0));
    }
    if (gained <= 0) {
      if (inferredMoved > 0) {
        noteStationInventoryTransfer(bot, source, inferredMoved);
        log({
          type: "station_inventory_withdraw_pending",
          item: normalizedItem,
          station: source.stationType || null,
          slot: source.slot || null,
          inferredMoved
        });
      }
      continue;
    }
    gainedTotal += gained;
    noteStationInventoryTransfer(bot, source, Math.max(gained, inferredMoved));
    log({
      type: "station_inventory_withdraw",
      item: normalizedItem,
      station: source.stationType || null,
      slot: source.slot || null,
      gained,
      inferredMoved: inferredMoved || undefined
    });
  }

  return { ok: true, gained: gainedTotal };
}

async function retrieveIngredientDeficitsFromStations(bot, ingredients, cfg, runCtx, log) {
  for (const ingredient of ingredients || []) {
    const item = normalizeItemName(ingredient?.name);
    const needed = Math.max(1, Number(ingredient?.count || 1));
    if (!item || inventoryCount(bot, item) >= needed) continue;
    const pulled = await retrieveNearbyStationItems(bot, item, needed, cfg, runCtx, log);
    if (pulled?.status === "cancel") return pulled;
  }
  return { ok: true };
}

function selectBestCraftRecipe(recipes, item, bot, cfg, log = () => {}) {
  if (!Array.isArray(recipes) || !recipes.length) return null;
  const mcData = require("minecraft-data")(bot.version);
  const inv = availableInventorySnapshot(bot);
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

function plannedCraftIngredients(args = {}) {
  if (!Array.isArray(args.ingredients)) return [];
  return args.ingredients
    .map((ing) => ({
      name: normalizeItemName(ing?.name),
      count: Math.max(1, Number(ing?.count || 1))
    }))
    .filter((ing) => !!ing.name);
}

function craftIngredientDeficits(bot, ingredients, cfg = {}) {
  const inv = inventorySnapshot(bot);
  const deficits = [];
  for (const ing of ingredients) {
    const item = normalizeItemName(ing?.name);
    const needed = Math.max(1, Number(ing?.count || 1));
    if (!item) continue;
    const have = equivalentInventoryCount(inv, item, cfg);
    if (have < needed) {
      deficits.push({
        item,
        needed,
        have,
        missing: needed - have
      });
    }
  }
  return deficits;
}

async function craftRecipeStep(bot, args, cfg, runCtx, log, ctx) {
  const item = normalizeItemName(args?.item);
  const count = Math.max(1, Number(args?.count || 1));
  const processType = normalizeItemName(args?.processType || "craft");
  const ingredients = plannedCraftIngredients(args);
  if (!item) return { ok: false, code: "invalid_item", reason: "invalid craft item", nextNeed: "specify item", recoverable: false };
  if (processType !== "craft") {
    return {
      ok: false,
      code: "unsupported_station_process",
      reason: `unsupported process ${processType} for craft step`,
      nextNeed: `use ${processType} station handler`,
      recoverable: false
    };
  }
  if (item === "planks") {
    const res = await ensureItem(bot, "planks", count, cfg, runCtx, log, { tableBlock: null });
    return normalizeStepResult(res, "craft_planks_failed");
  }

  const mcData = require("minecraft-data")(bot.version);
  const outputItem = normalizeItemName(args?.outputItem || item);
  const itemInfo = mcData.itemsByName[outputItem];
  if (!itemInfo) return { ok: false, code: "unknown_item", reason: `unknown item ${item}`, nextNeed: "valid item name", recoverable: false };

  const station = normalizeItemName(args?.station || "inventory");
  let tableBlock = null;
  if (station === "crafting_table") {
    const ensured = await ensureStation(bot, "crafting_table", cfg, runCtx, log, ctx);
    if (!ensured.ok) return ensured;
    tableBlock = ctx.stations.crafting_table || null;
  }

  const targetCount = stepTargetInventoryCount(bot, item, count);
  let loops = 0;
  while (inventoryCount(bot, item) < targetCount) {
    if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
    if (loops++ > 48) {
      return { ok: false, code: "craft_loop_limit", reason: `craft loop limit for ${item}`, nextNeed: `check ingredients for ${item}`, recoverable: false };
    }

    if (station === "crafting_table") {
      let activeTable = tableBlock;
      if (!activeTable || !activeTable.position) {
        activeTable = findNearbyStation(bot, "crafting_table", configuredStationSearchRadius(cfg));
      }
      if (!activeTable || !activeTable.position) {
        return {
          ok: false,
          code: "missing_table",
          reason: "need crafting_table nearby",
          nextNeed: "place crafting_table",
          recoverable: false
        };
      }

      const tableDist = bot.entity.position.distanceTo(activeTable.position);
      if (tableDist > 4.5) {
        const timeoutMs = moveTimeoutForDistance(cfg, tableDist);
        const reachedTable = await moveNearWithReasoning(
          bot,
          activeTable.position,
          2,
          timeoutMs,
          runCtx,
          cfg,
          log,
          "craft_recipe_move_table"
        );
        if (!reachedTable) {
          return {
            ok: false,
            code: "path_blocked",
            reason: "path blocked to crafting table",
            nextNeed: "move near crafting table",
            recoverable: true
          };
        }
      }
      tableBlock = activeTable;
      ctx.stations.crafting_table = activeTable;
    }

    const maxProbeRetries = 2;
    let probe = 0;
    let recipe = null;
    let preflightDone = false;
    let lastProbeInfo = null;

    while (!recipe && probe <= maxProbeRetries) {
      const tableRecipes = bot.recipesFor(itemInfo.id, null, 1, tableBlock || null) || [];
      const inventoryRecipes = tableBlock ? (bot.recipesFor(itemInfo.id, null, 1, null) || []) : [];
      const recipeCandidates = [...tableRecipes, ...inventoryRecipes];
      lastProbeInfo = {
        tableCandidates: tableRecipes.length,
        inventoryCandidates: inventoryRecipes.length,
        totalCandidates: recipeCandidates.length
      };
      log({
        type: "craft_recipe_probe",
        item,
        outputItem,
        station,
        probe: probe + 1,
        hasTable: !!tableBlock,
        ...lastProbeInfo
      });

      recipe = selectBestCraftRecipe(recipeCandidates, outputItem, bot, cfg, log);
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

      if (!recipe && !preflightDone && ingredients.length) {
        const pulledIngredients = await retrieveIngredientDeficitsFromStations(bot, ingredients, cfg, runCtx, log);
        if (pulledIngredients?.status === "cancel") return pulledIngredients;
        const deficits = craftIngredientDeficits(bot, ingredients, cfg);
        if (deficits.length) {
          log({
            type: "craft_recipe_missing_ingredients",
            item,
            outputItem,
            station,
            deficits
          });
          for (const deficit of deficits) {
            const target = inventoryCount(bot, deficit.item) + deficit.missing;
            const ensured = await ensureItem(bot, deficit.item, target, cfg, runCtx, log, ctx);
            const normalized = normalizeStepResult(ensured, "craft_recipe_preflight_failed");
            if (normalized.status === "cancel") return normalized;
            if (!normalized.ok) return normalized;
          }
        }
        preflightDone = true;
      }

      if (!recipe && station === "crafting_table" && tableBlock?.position) {
        const tableDist = bot.entity.position.distanceTo(tableBlock.position);
        if (tableDist > 3.0) {
          const reachedTable = await moveNearWithReasoning(
            bot,
            tableBlock.position,
            1,
            moveTimeoutForDistance(cfg, tableDist),
            runCtx,
            cfg,
            log,
            "craft_recipe_probe_table"
          );
          if (!reachedTable) {
            return {
              ok: false,
              code: "path_blocked",
              reason: "path blocked to crafting table",
              nextNeed: "move near crafting table",
              recoverable: true
            };
          }
        }
      }

      if (!recipe && probe < maxProbeRetries) {
        log({
          type: "craft_recipe_retry",
          item,
          outputItem,
          station,
          probe: probe + 1,
          nextProbe: probe + 2
        });
        const waited = await waitTicks(bot, 2, runCtx);
        if (!waited) return { ok: false, status: "cancel" };
      }
      probe += 1;
    }

    if (!recipe) {
      log({
        type: "craft_recipe_fail_detail",
        item,
        outputItem,
        station,
        hasTable: !!tableBlock,
        tableDistance: tableBlock?.position
          ? Number(bot.entity.position.distanceTo(tableBlock.position).toFixed(2))
          : null,
        deficits: ingredients.length ? craftIngredientDeficits(bot, ingredients, cfg) : [],
        localBlocks: localBlockSummary(bot, 4, 8),
        ...lastProbeInfo
      });
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

function findCandidateBlocks(bot, blockNames, preferredBlocks, maxDistance, options = {}) {
  const matchSet = new Set((blockNames || []).map((n) => normalizeItemName(n)).filter(Boolean));
  if (!matchSet.size) return [];
  const logSearch = options.logSearch === true;
  const preferred = Array.isArray(preferredBlocks) && preferredBlocks.length
    ? preferredBlocks.map((n) => normalizeItemName(n)).filter(Boolean)
    : Array.from(matchSet.values());
  const preference = new Map(preferred.map((name, idx) => [name, idx]));
  const rankFor = (name) => {
    const key = normalizeItemName(name);
    return preference.has(key) ? preference.get(key) : preferred.length + 10;
  };
  const sampleCount = Math.max(32, Number(options.blockSampleCount || 128));
  const candidateLimit = Math.max(1, Number(options.candidateLimit || 8));
  const exclude = options.excludePositions instanceof Set ? options.excludePositions : null;
  const treeHints = Array.isArray(options.treeHints) ? options.treeHints : [];
  const candidates = [];
  const seen = new Set();
  const treeCache = new Map();

  const pushBlock = (block) => {
    if (!block?.position) return;
    const key = blockPosKey(block.position);
    if (!key) return;
    if (exclude && exclude.has(key)) return;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(block);
  };

  if (typeof bot.findBlocks === "function") {
    const positions = bot.findBlocks({
      matching: (b) => !!b && matchSet.has(normalizeItemName(b.name)),
      maxDistance,
      count: sampleCount
    }) || [];
    for (const pos of positions) {
      pushBlock(bot.blockAt(pos));
    }
  } else if (typeof bot.findBlock === "function") {
    pushBlock(bot.findBlock({
      matching: (b) => !!b && matchSet.has(normalizeItemName(b.name)),
      maxDistance
    }) || null);
  }

  for (const block of localScanCandidates(bot, matchSet, maxDistance, sampleCount)) {
    pushBlock(block);
  }

  const eyeY = Number(bot.entity?.position?.y || 0);
  const scored = candidates
    .map((block) => {
      const dist = bot.entity.position.distanceTo(block.position);
      const yDelta = Math.abs(Number(block.position?.y || 0) - eyeY);
      const prefRank = rankFor(block.name);
      const stand = selectBestStandSpot(bot, block, { rejectLogOrLeavesSupport: logSearch });
      const standDist = stand ? stand.standDistance : Number.POSITIVE_INFINITY;
      const directReach = dist <= 3.1;
      const moveCost = Number.isFinite(standDist)
        ? standDist
        : (directReach && !logSearch ? 0.5 : 999);
      const standable = !!stand && Number.isFinite(moveCost);
      const pickupSafe = !!stand && stand.pickupSafe === true;
      const noStandPenalty = standable ? 0 : (directReach && !logSearch ? 1200 : 2000);
      const lowClearancePenalty = pickupSafe ? 0 : 300;
      const treeInfo = logSearch
        ? (() => {
            const key = blockPosKey(block.position);
            if (treeCache.has(key)) return treeCache.get(key);
            const built = normalizeTreeInfo(buildConnectedLogCluster(bot, block, matchSet, {
              maxNodes: 24,
              maxManhattanDistance: 8
            }), treeHints);
            for (const pos of built.positions || []) {
              treeCache.set(blockPosKey(pos), built);
            }
            treeCache.set(key, built);
            return built;
          })()
        : null;
      const usable = !logSearch || (!!stand?.standPos && stand.safe === true && pickupSafe === true);
      const score = prefRank * 1000 + noStandPenalty + lowClearancePenalty + moveCost * 3 + dist + yDelta * 2;
      return {
        block,
        standPos: stand?.standPos || null,
        standDistance: Number.isFinite(stand?.standDistance) ? stand.standDistance : null,
        unsafeReasons: Array.isArray(stand?.unsafeReasons) ? stand.unsafeReasons : ["no_safe_stand"],
        pickupSafe,
        treeId: treeInfo?.treeId || null,
        treePositions: Array.isArray(treeInfo?.positions) ? treeInfo.positions : [],
        usable,
        score,
        dist,
        yDelta,
        standable
      };
    })
    .filter((row) => Number.isFinite(row.score))
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.dist !== b.dist) return a.dist - b.dist;
      if (a.yDelta !== b.yDelta) return a.yDelta - b.yDelta;
      if (a.block.position.x !== b.block.position.x) return a.block.position.x - b.block.position.x;
      if (a.block.position.y !== b.block.position.y) return a.block.position.y - b.block.position.y;
      return a.block.position.z - b.block.position.z;
    });

  return scored.slice(0, candidateLimit);
}

function findNearestCandidateBlock(bot, blockNames, preferredBlocks, maxDistance, options = {}) {
  const candidates = findCandidateBlocks(bot, blockNames, preferredBlocks, maxDistance, options);
  return candidates[0] || null;
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
  const sourceLabel = gatherSourceLabel(item, blockNames);
  const logSearch = item === "log";
  const stepRequirement = normalizeToolRequirement(args?.toolRequirement);
  const strictToolGate = cfg.strictHarvestToolGate !== false;
  const autoAcquireRequiredTools = cfg.autoAcquireRequiredTools !== false;
  const mcData = require("minecraft-data")(bot.version);
  if (bot?.registry && bot?.pathfinder?.setMovements && typeof Movements === "function") {
    try {
      const movements = new Movements(bot);
      movements.allow1by1towers = true;
      movements.allowParkour = false;
      movements.canDig = true;
      bot.pathfinder.setMovements(movements);
    } catch {}
  }
  const configuredRings = Array.isArray(cfg.gatherRadiusSteps) && cfg.gatherRadiusSteps.length
    ? cfg.gatherRadiusSteps
    : [cfg.autoGatherRadius || cfg.craftGatherRadius || 48];
  const rings = configuredRings
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const retriesPerRing = Math.max(1, Number(cfg.gatherExpandRetryPerRing || 2));
  const targetCandidateLimit = Math.max(1, Number(cfg.gatherTargetCandidates || 6));
  const targetFailLimit = Math.max(1, Number(cfg.gatherTargetFailLimit || 2));
  const candidateBanMs = Math.max(1000, Number(cfg.gatherCandidateBanMs || 15000));
  const logCandidateBanMs = Math.max(candidateBanMs, Number(cfg.gatherLogCandidateBanMs || 45000));
  const sameTreeFollowups = Math.max(0, Number(cfg.gatherLogSameTreeFollowups || 2));
  const treeFailLimit = Math.max(1, Number(cfg.gatherTreeFailLimit || 2));
  const dropRecoveryRetries = Math.max(1, Number(cfg.gatherDropRecoveryRetries || 2));
  const dropRecoverMoveTimeoutMs = Math.max(750, Number(cfg.gatherDropRecoverMoveTimeoutMs || 2500));
  const failedTargets = new Map();
  const failedTrees = new Map();
  let activeTree = null;

  const knownTreeHints = () => {
    const hints = [];
    if (activeTree?.treeId) hints.push(activeTree);
    for (const [treeId, rec] of failedTrees.entries()) {
      hints.push(makeTreeRecord(treeId, rec?.positions || []));
    }
    return hints;
  };

  const expireFailures = (map, fallbackBanMs) => {
    const nowMs = Date.now();
    for (const [key, rec] of map.entries()) {
      if (!rec || typeof rec !== "object") {
        map.delete(key);
        continue;
      }
      const banMs = Math.max(1000, Number(rec.banMs || fallbackBanMs));
      if (nowMs - Number(rec.lastFailedAt || 0) >= banMs) map.delete(key);
    }
  };

  const noteTargetFailure = (targetKey, reason, treeId = null, treePositions = []) => {
    if (targetKey) {
      const prev = failedTargets.get(targetKey);
      failedTargets.set(targetKey, {
        fails: Number(prev?.fails || 0) + 1,
        lastFailedAt: Date.now(),
        reason,
        treeId: treeId || prev?.treeId || null,
        banMs: logSearch ? logCandidateBanMs : candidateBanMs
      });
    }
    if (logSearch && treeId) {
      const prevTree = failedTrees.get(treeId);
      const nextFails = Number(prevTree?.fails || 0) + 1;
      const positions = mergeTreePositions(prevTree?.positions || [], treePositions);
      failedTrees.set(treeId, {
        fails: nextFails,
        lastFailedAt: Date.now(),
        reason,
        banMs: logCandidateBanMs,
        positions,
        positionKeys: positionKeySet(positions)
      });
      if (nextFails >= treeFailLimit && activeTree?.treeId === treeId) {
        activeTree = null;
      }
    }
  };

  const clearTargetFailure = (targetKey, treeId = null) => {
    if (targetKey) failedTargets.delete(targetKey);
    if (logSearch && treeId) failedTrees.delete(treeId);
  };

  const consumeTreeFollowupAttempt = (treeId, treePositions = []) => {
    if (!logSearch || !treeId || !activeTree || activeTree.treeId !== treeId) return;
    activeTree.positions = mergeTreePositions(activeTree.positions || [], treePositions);
    activeTree.positionKeys = positionKeySet(activeTree.positions);
    activeTree.followupsRemaining -= 1;
    if (activeTree.followupsRemaining <= 0) activeTree = null;
  };

  const markTreeGatherSuccess = (treeId, treePositions = []) => {
    if (!logSearch || !treeId || sameTreeFollowups <= 0) return;
    const positions = mergeTreePositions(activeTree?.positions || [], treePositions);
    if (!activeTree || activeTree.treeId !== treeId) {
      activeTree = {
        treeId,
        positions,
        positionKeys: positionKeySet(positions),
        followupsRemaining: sameTreeFollowups
      };
      return;
    }
    activeTree.positions = positions;
    activeTree.positionKeys = positionKeySet(positions);
    activeTree.followupsRemaining -= 1;
    if (activeTree.followupsRemaining <= 0) activeTree = null;
  };

  const targetCount = stepTargetInventoryCount(bot, item, count);
  let confirmedGathered = 0;
  while ((inventoryCount(bot, item) + confirmedGathered) < targetCount) {
    if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
    const maxRing = rings[rings.length - 1] || 48;
    let gatheredThisLoop = false;
    let sawObservedCandidate = false;
    let dropRecoveryFailures = 0;

    for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
      const radius = rings[ringIndex];
      reportProgress(runCtx, `search ${item} radius ${radius}`, {
        stepAction: "gather_block",
        gatherRingIndex: ringIndex + 1,
        progressKind: "heartbeat",
        msg: `search ${item} radius ${radius}`
      });

      for (let attempt = 1; attempt <= retriesPerRing; attempt += 1) {
        if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
        reportProgress(runCtx, `gather ${item} r${radius} try ${attempt}/${retriesPerRing}`, {
          stepAction: "gather_block",
          gatherRingIndex: ringIndex + 1,
          progressKind: "heartbeat",
          attempt
        });

        expireFailures(failedTargets, candidateBanMs);
        expireFailures(failedTrees, logCandidateBanMs);
        const blockedPositions = new Set(
          Array.from(failedTargets.entries())
            .filter(([, rec]) => Number(rec?.fails || 0) >= targetFailLimit)
            .map(([key]) => key)
        );
        const blockedTreeIds = new Set(
          Array.from(failedTrees.entries())
            .filter(([, rec]) => Number(rec?.fails || 0) >= treeFailLimit)
            .map(([key]) => key)
        );
        if (blockedPositions.size > 0) {
          log({
            type: "gather_candidate_skip_recent_fail",
            item,
            radius,
            attempt,
            blockedCount: blockedPositions.size
          });
        }
        let candidates = findCandidateBlocks(bot, blockNames, preferredBlocks, radius, {
          blockSampleCount: cfg.gatherBlockSampleCount || 128,
          candidateLimit: Math.max(targetCandidateLimit, targetCandidateLimit * 3),
          excludePositions: blockedPositions,
          logSearch,
          treeHints: knownTreeHints()
        });
        if (!candidates.length) {
          const nearby = localBlockSummary(bot, 4, 8);
          log({
            type: "gather_scan_none",
            item,
            radius,
            attempt,
            blockNames: blockNames.slice(0, 8),
            blockedTargetCount: blockedPositions.size,
            nearby
          });
          const waitedNoBlock = await waitTicks(bot, 6, runCtx);
          if (!waitedNoBlock) return { ok: false, status: "cancel" };
          continue;
        }

        sawObservedCandidate = true;
        candidates = candidates.filter((candidate) => !candidate.treeId || !blockedTreeIds.has(candidate.treeId));
        if (logSearch && activeTree?.treeId) {
          const sameTreeCandidates = candidates.filter((candidate) => candidate.treeId === activeTree.treeId);
          if (sameTreeCandidates.length > 0) {
            candidates = sameTreeCandidates;
          } else {
            activeTree = null;
          }
        }
        candidates = candidates.filter((candidate) => !logSearch || candidate.usable !== false);
        if (!candidates.length) {
          log({
            type: "gather_target_skip_unsafe",
            item,
            radius,
            attempt,
            blockedTargetCount: blockedPositions.size,
            blockedTreeCount: blockedTreeIds.size,
            activeTreeId: activeTree?.treeId || null
          });
          const waitedUnsafe = await waitTicks(bot, 4, runCtx);
          if (!waitedUnsafe) return { ok: false, status: "cancel" };
          continue;
        }

        const target = candidates[0];
        const block = target.block;
        if (!block) {
          const waitedMissingTarget = await waitTicks(bot, 4, runCtx);
          if (!waitedMissingTarget) return { ok: false, status: "cancel" };
          continue;
        }
        const standPos = target.standPos || null;
        const targetKey = blockPosKey(block.position);
        const treeId = target.treeId || null;
        const treePositions = Array.isArray(target.treePositions) ? target.treePositions : [];

        log({
          type: "gather_target_selected",
          item,
          block: normalizeItemName(block.name),
          x: block.position.x,
          y: block.position.y,
          z: block.position.z,
          standX: standPos?.x ?? null,
          standY: standPos?.y ?? null,
          standZ: standPos?.z ?? null,
          score: Number.isFinite(target.score) ? Number(target.score.toFixed(2)) : null,
          standDistance: Number.isFinite(target.standDistance) ? Number(target.standDistance.toFixed(2)) : null,
          pickupSafe: target.pickupSafe === true,
          unsafeReasons: Array.isArray(target.unsafeReasons) ? target.unsafeReasons : [],
          treeId,
          radius,
          attempt,
          distance: Number((bot.entity.position.distanceTo(block.position) || 0).toFixed(2))
        });

        const dynamicMoveTimeoutMs = moveTimeoutForDistance(
          cfg,
          bot.entity?.position?.distanceTo?.(standPos || block.position) || radius
        );

        const moveTarget = standPos || block.position;
        const moveRadius = standPos ? 1 : 2;
        const reached = await moveNearWithReasoning(
          bot,
          moveTarget,
          moveRadius,
          dynamicMoveTimeoutMs,
          runCtx,
          cfg,
          log,
          "gather_block_move"
        );
        if (!reached) {
          noteTargetFailure(targetKey, "path_blocked", treeId, treePositions);
          consumeTreeFollowupAttempt(treeId, treePositions);
          log({
            type: "gather_target_reject",
            item,
            block: normalizeItemName(block.name),
            reason: "path_blocked",
            treeId,
            failedCount: Number(failedTargets.get(targetKey)?.fails || 1),
            treeFailedCount: Number(failedTrees.get(treeId)?.fails || 0)
          });
          const waitedMoveFail = await waitTicks(bot, 4, runCtx);
          if (!waitedMoveFail) return { ok: false, status: "cancel" };
          continue;
        }

        const before = inventoryCount(bot, item);
        let activeRequirement = null;
        try {
          const digBlock = bot.blockAt(block.position);
          if (!digBlock) {
            noteTargetFailure(targetKey, "target_missing", treeId, treePositions);
            consumeTreeFollowupAttempt(treeId, treePositions);
            const waitedMissing = await waitTicks(bot, 4, runCtx);
            if (!waitedMissing) return { ok: false, status: "cancel" };
            continue;
          }

          if (strictToolGate) {
            activeRequirement = normalizeToolRequirement(getBlockToolRequirement(digBlock, mcData)) || stepRequirement;
            if (activeRequirement) {
              const blockName = normalizeItemName(digBlock.name);
              let equipped = normalizeItemName(bot.heldItem?.name || "");
              const initiallySufficient = isToolSufficient(equipped, activeRequirement);
              log({
                type: "gather_tool_required",
                item,
                block: blockName,
                toolRequirement: activeRequirement
              });
              log({
                type: "gather_tool_check",
                item,
                block: blockName,
                toolRequirement: activeRequirement,
                heldItem: equipped || null,
                sufficient: initiallySufficient
              });
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
                        code: "progression_blocked",
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
                    code: "progression_blocked",
                    reason: `need ${needTool} for ${normalizeItemName(digBlock.name)}`,
                    nextNeed: `craft ${needTool}`,
                    recoverable: false
                  };
                }

                try {
                  await bot.equip(toolItem, "hand");
                } catch {
                  const needTool = minimumToolName(activeRequirement) || normalizeItemName(toolItem.name);
                  log({
                    type: "gather_tool_equip_fail",
                    item,
                    block: normalizeItemName(digBlock.name),
                    needTool
                  });
                  return {
                    ok: false,
                    code: "progression_blocked",
                    reason: `failed equipping ${needTool} for ${normalizeItemName(digBlock.name)}`,
                    nextNeed: `equip ${needTool}`,
                    recoverable: false
                  };
                }
                equipped = normalizeItemName(bot.heldItem?.name || toolItem.name);
                log({
                  type: "gather_tool_equip",
                  item,
                  block: blockName,
                  equipped,
                  toolRequirement: activeRequirement
                });
                if (!isToolSufficient(equipped, activeRequirement)) {
                  return {
                    ok: false,
                    code: "progression_blocked",
                    reason: `held tool incompatible for ${normalizeItemName(digBlock.name)}`,
                    nextNeed: `equip ${minimumToolName(activeRequirement) || activeRequirement.toolType}`,
                    recoverable: false
                  };
                }
              }
            }
          }
          if (strictToolGate && activeRequirement) {
            const currentHeld = normalizeItemName(bot.heldItem?.name || "");
            if (!isToolSufficient(currentHeld, activeRequirement)) {
              const toolNow = pickBestInventoryTool(bot, activeRequirement);
              const needTool = minimumToolName(activeRequirement) || `${activeRequirement.minTier || "wooden"}_${activeRequirement.toolType}`;
              if (!toolNow) {
                log({
                  type: "gather_tool_missing",
                  item,
                  block: normalizeItemName(digBlock.name),
                  needTool
                });
                return {
                  ok: false,
                  code: "progression_blocked",
                  reason: `need ${needTool} for ${normalizeItemName(digBlock.name)}`,
                  nextNeed: `craft ${needTool}`,
                  recoverable: false
                };
              }
              try {
                await bot.equip(toolNow, "hand");
              } catch {
                log({
                  type: "gather_tool_equip_fail",
                  item,
                  block: normalizeItemName(digBlock.name),
                  needTool
                });
                return {
                  ok: false,
                  code: "progression_blocked",
                  reason: `failed equipping ${needTool} for ${normalizeItemName(digBlock.name)}`,
                  nextNeed: `equip ${needTool}`,
                  recoverable: false
                };
              }
              const heldAfterEquip = normalizeItemName(bot.heldItem?.name || toolNow.name);
              log({
                type: "gather_tool_equip",
                item,
                block: normalizeItemName(digBlock.name),
                equipped: heldAfterEquip,
                toolRequirement: activeRequirement
              });
              if (!isToolSufficient(heldAfterEquip, activeRequirement)) {
                return {
                  ok: false,
                  code: "progression_blocked",
                  reason: `held tool incompatible for ${normalizeItemName(digBlock.name)}`,
                  nextNeed: `equip ${needTool}`,
                  recoverable: false
                };
              }
            }
          }
          log({
            type: "gather_dig_start",
            item,
            block: normalizeItemName(digBlock.name),
            heldItem: normalizeItemName(bot.heldItem?.name || "")
          });
          if (typeof bot.canDigBlock === "function" && !bot.canDigBlock(digBlock)) {
            const adjusted = await moveNearWithReasoning(
              bot,
              digBlock.position,
              2,
              Math.min(dynamicMoveTimeoutMs, 6000),
              runCtx,
              cfg,
              log,
              "gather_block_adjust"
            );
            const canDigAfterAdjust = typeof bot.canDigBlock !== "function" || bot.canDigBlock(digBlock);
            if (!adjusted || !canDigAfterAdjust) {
              noteTargetFailure(targetKey, "cannot_dig_from_position", treeId, treePositions);
              consumeTreeFollowupAttempt(treeId, treePositions);
              log({
                type: "gather_target_reject",
                item,
                block: normalizeItemName(digBlock.name),
                reason: "cannot_dig_from_position",
                treeId,
                failedCount: Number(failedTargets.get(targetKey)?.fails || 1),
                treeFailedCount: Number(failedTrees.get(treeId)?.fails || 0)
              });
              const waitedAdjustFail = await waitTicks(bot, 4, runCtx);
              if (!waitedAdjustFail) return { ok: false, status: "cancel" };
              continue;
            }
          }
          if (timeoutsDisabled(cfg)) {
            await bot.dig(digBlock, true);
          } else {
            const digTimeoutMs = Math.max(250, Number(cfg.gatherDigTimeoutMs || 7000));
            const digAttempt = bot.dig(digBlock, true)
              .then(() => ({ ok: true }))
              .catch((error) => ({ ok: false, error }));
            const digResult = await Promise.race([
              digAttempt,
              new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), digTimeoutMs))
            ]);
            if (!digResult?.ok) {
              if (digResult?.timeout && typeof bot.stopDigging === "function") {
                try { bot.stopDigging(); } catch {}
              }
              throw new Error(digResult?.timeout ? "dig_timeout" : String(digResult?.error || "dig_failed"));
            }
          }
        } catch (e) {
          noteTargetFailure(targetKey, "dig_error", treeId, treePositions);
          consumeTreeFollowupAttempt(treeId, treePositions);
          log({
            type: "gather_dig_error",
            item,
            treeId,
            error: String(e)
          });
          const waitedDigFail = await waitTicks(bot, 4, runCtx);
          if (!waitedDigFail) return { ok: false, status: "cancel" };
          continue;
        }

        const waited = await waitTicks(bot, 2, runCtx);
        if (!waited) return { ok: false, status: "cancel" };
        const afterImmediate = inventoryCount(bot, item);
        if (afterImmediate > before) {
          gatheredThisLoop = true;
          clearTargetFailure(targetKey, treeId);
          markTreeGatherSuccess(treeId, treePositions);
          log({
            type: "gather_dig_result",
            item,
            treeId,
            result: "ok",
            gained: afterImmediate - before
          });
          reportProgress(runCtx, `gathered ${item}`, {
            stepAction: "gather_block",
            gatherRingIndex: ringIndex + 1,
            attempt
          });
          break;
        }
        const postDigBlock = bot.blockAt(block.position);
        const postDigName = normalizeItemName(postDigBlock?.name || "");
        const blockCleared =
          !postDigBlock ||
          postDigBlock.boundingBox === "empty" ||
          postDigName === "air" ||
          postDigName === "cave_air" ||
          postDigName === "void_air";

        if (blockCleared) {
          log({
            type: "gather_dig_result",
            item,
            treeId,
            result: "block_broken_wait_pickup",
            heldItem: normalizeItemName(bot.heldItem?.name || "")
          });
          const waitedPickup = await waitTicks(bot, 12, runCtx);
          if (!waitedPickup) return { ok: false, status: "cancel" };
          const afterPickup = inventoryCount(bot, item);
          if (afterPickup > before) {
            gatheredThisLoop = true;
            clearTargetFailure(targetKey, treeId);
            markTreeGatherSuccess(treeId, treePositions);
            log({
              type: "gather_dig_result",
              item,
              treeId,
              result: "ok_after_pickup_wait",
              gained: afterPickup - before
            });
            reportProgress(runCtx, `gathered ${item}`, {
              stepAction: "gather_block",
              gatherRingIndex: ringIndex + 1,
              attempt
            });
            break;
          }
          for (let pickupTry = 1; pickupTry <= dropRecoveryRetries; pickupTry += 1) {
            const dropScan = scanNearbyDropEntities(bot, block.position, 5, item);
            log({
              type: "gather_drop_scan",
              item,
              treeId,
              radius,
              attempt,
              pickupTry,
              dropCount: dropScan.count,
              totalDropCount: dropScan.totalCount,
              typedDropCount: dropScan.typedCount,
              nearestDropDistance: Number.isFinite(dropScan.nearestDistance) ? Number(dropScan.nearestDistance.toFixed(2)) : null
            });
            if (dropScan.count <= 0 || !dropScan.nearest?.position) {
              const waitedNoDrop = await waitTicks(bot, 2, runCtx);
              if (!waitedNoDrop) return { ok: false, status: "cancel" };
              continue;
            }
            const pickupTarget = dropScan.nearest?.position || block.position;
            const movedForPickup = await moveNearWithReasoning(
              bot,
              pickupTarget,
              1,
              Math.min(dynamicMoveTimeoutMs, dropRecoverMoveTimeoutMs),
              runCtx,
              cfg,
              log,
              "gather_drop_recover_move"
            );
            log({
              type: "gather_drop_recover_move",
              item,
              treeId,
              radius,
              attempt,
              pickupTry,
              moved: movedForPickup
            });
            if (!movedForPickup) {
              const waitedMoveRetry = await waitTicks(bot, 2, runCtx);
              if (!waitedMoveRetry) return { ok: false, status: "cancel" };
              continue;
            }

            const waitedClosePickup = await waitTicks(bot, 8, runCtx);
            if (!waitedClosePickup) return { ok: false, status: "cancel" };
            const afterClosePickup = inventoryCount(bot, item);
            const postScan = scanNearbyDropEntities(bot, block.position, 5, item);
            log({
              type: "gather_pickup_retry",
              item,
              treeId,
              radius,
              attempt,
              pickupTry,
              gained: Math.max(0, afterClosePickup - before),
              dropCountBefore: dropScan.count,
              dropCountAfter: postScan.count
            });
            const confirmedByDrop = dropScan.count > 0 && postScan.count < dropScan.count;
            if (afterClosePickup > before || confirmedByDrop) {
              gatheredThisLoop = true;
              clearTargetFailure(targetKey, treeId);
              markTreeGatherSuccess(treeId, treePositions);
              if (afterClosePickup <= before && confirmedByDrop) {
                confirmedGathered += 1;
              }
              log({
                type: "gather_dig_result",
                item,
                treeId,
                result: afterClosePickup > before ? "ok_after_close_pickup" : "ok_after_drop_confirm",
                gained: Math.max(0, afterClosePickup - before)
              });
              reportProgress(runCtx, `gathered ${item}`, {
                stepAction: "gather_block",
                gatherRingIndex: ringIndex + 1,
                attempt
              });
              break;
            }
          }
          if (gatheredThisLoop) {
            break;
          }
          noteTargetFailure(targetKey, "no_pickup_after_break", treeId, treePositions);
          consumeTreeFollowupAttempt(treeId, treePositions);
          dropRecoveryFailures += 1;
          log({
            type: "gather_drop_recovery_failed",
            item,
            treeId,
            radius,
            attempt
          });
          log({
            type: "gather_dig_result",
            item,
            treeId,
            result: "no_pickup_after_break",
            heldItem: normalizeItemName(bot.heldItem?.name || "")
          });
          continue;
        }
        noteTargetFailure(targetKey, "no_yield_block_intact", treeId, treePositions);
        consumeTreeFollowupAttempt(treeId, treePositions);
        log({
          type: "gather_dig_result",
          item,
          treeId,
          result: "no_yield_block_intact",
          heldItem: normalizeItemName(bot.heldItem?.name || "")
        });
        if (strictToolGate && activeRequirement) {
          const held = normalizeItemName(bot.heldItem?.name || "");
          if (!isToolSufficient(held, activeRequirement)) {
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
              code: "progression_blocked",
              reason: `need ${needTool} for ${blockName}`,
              nextNeed: `craft ${needTool}`,
              recoverable: false
            };
          }
        }
      }

      if (gatheredThisLoop) break;
    }

    if (!gatheredThisLoop) {
      if (sawObservedCandidate) {
        if (dropRecoveryFailures > 0) {
          return {
            ok: false,
            code: "drop_recovery_failed",
            reason: `failed pickup recovery for ${sourceLabel} drops (within ${maxRing})`,
            nextNeed: logSearch ? "move closer to dropped logs" : "move closer to dropped items",
            recoverable: false
          };
        }
        return {
          ok: false,
          code: "path_blocked",
          reason: logSearch
            ? `can't reach productive ${sourceLabel} source (within ${maxRing})`
            : `can't reach ${sourceLabel} source (within ${maxRing})`,
          nextNeed: logSearch ? "move to open area near tree trunk" : "move to open area near target blocks",
          recoverable: false
        };
      }
      const fromRadius = maxRing;
      const toRadius = Math.max(fromRadius + 1, Number(cfg.missingResourceExpandedRadius || 120));
      const policy = String(cfg.missingResourcePolicy || "ask_before_move").toLowerCase();
      log({
        type: "resource_search_boundary",
        item,
        fromRadius,
        toRadius,
        policy,
        requiresConfirm: false
      });
      return {
        ok: false,
        code: "resource_not_loaded",
        reason: `no ${sourceLabel} source nearby (within ${fromRadius})`,
        nextNeed: `move to area with ${sourceLabel} source`,
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

  const targetCount = stepTargetInventoryCount(bot, item, count);
  while (inventoryCount(bot, item) < targetCount) {
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

  const targetCount = stepTargetInventoryCount(bot, item, count);
  while (inventoryCount(bot, item) < targetCount) {
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

async function stationRecipeStep(bot, args, cfg, runCtx, log, ctx) {
  const item = normalizeItemName(args?.item);
  const count = Math.max(1, Number(args?.count || 1));
  const station = normalizeItemName(args?.station || "stonecutter");
  const processType = normalizeItemName(args?.processType || "station");
  if (!item) {
    return { ok: false, code: "invalid_item", reason: "invalid station item", nextNeed: "specify item", recoverable: false };
  }

  const ensured = await ensureStation(bot, station, cfg, runCtx, log, ctx);
  if (!ensured.ok) return ensured;
  const stationBlock = ctx.stations?.[station] || ensured?.data || null;
  if (!stationBlock) {
    return {
      ok: false,
      code: "station_unavailable",
      reason: `need ${station} nearby`,
      nextNeed: `place ${station}`,
      recoverable: false
    };
  }

  const mcData = require("minecraft-data")(bot.version);
  const itemInfo = mcData.itemsByName?.[item];
  if (!itemInfo) {
    return {
      ok: false,
      code: "unknown_item",
      reason: `unknown item ${item}`,
      nextNeed: "valid item name",
      recoverable: false
    };
  }

  const targetCount = stepTargetInventoryCount(bot, item, count);
  let loops = 0;
  while (inventoryCount(bot, item) < targetCount) {
    if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
    if (loops++ > 64) {
      return {
        ok: false,
        code: "station_loop_limit",
        reason: `station loop limit for ${item}`,
        nextNeed: `check ingredients for ${item}`,
        recoverable: false
      };
    }

    const recipes = bot.recipesFor(itemInfo.id, null, 1, stationBlock) || [];
    const recipe = selectBestCraftRecipe(recipes, item, bot, cfg, log);
    if (!recipe) {
      return {
        ok: false,
        code: "station_recipe_unavailable",
        reason: `${processType} recipe unavailable for ${item}`,
        nextNeed: `use supported ${station} recipe`,
        recoverable: false
      };
    }

    const recipeIngredients = parseRecipeIngredients(recipe, mcData).map((ing) => ({
      name: normalizePlanningItem(ing.name, cfg),
      count: ing.count
    }));
    const pulledIngredients = await retrieveIngredientDeficitsFromStations(bot, recipeIngredients, cfg, runCtx, log);
    if (pulledIngredients?.status === "cancel") return pulledIngredients;
    const deficits = craftIngredientDeficits(bot, recipeIngredients, cfg);
    for (const deficit of deficits) {
      const ensured = await ensureItem(bot, deficit.item, inventoryCount(bot, deficit.item) + deficit.missing, cfg, runCtx, log, ctx);
      const normalized = normalizeStepResult(ensured, "station_recipe_preflight_failed");
      if (normalized.status === "cancel") return normalized;
      if (!normalized.ok) return normalized;
    }

    try {
      await bot.craft(recipe, 1, stationBlock);
    } catch (e) {
      return {
        ok: false,
        code: "path_blocked",
        reason: `${processType} failed for ${item}`,
        nextNeed: `clear space near ${station}`,
        recoverable: true
      };
    }
    const waited = await waitTicks(bot, 2, runCtx);
    if (!waited) return { ok: false, status: "cancel" };
  }

  return { ok: true };
}

function outputSlotMatchesExpected(slot, outputId, expectedName, mcData) {
  if (!slot || Number(slot?.count || 0) <= 0) return false;
  const slotType = Number(slot?.type);
  const slotName = normalizeItemName(slot?.name || mcData?.items?.[slotType]?.name || "");
  const typeMatch = Number.isFinite(slotType) && Number(slotType) === Number(outputId);
  const nameMatch = !!expectedName && slotName === expectedName;
  return typeMatch || nameMatch;
}

async function tryTakeExpectedFurnaceOutput(bot, furnace, outputId, outputName, runCtx, mcData, retries = 3) {
  const expectedName = normalizeItemName(outputName || "");
  let sawExpected = false;
  let lastError = null;
  const attempts = Math.max(1, Number(retries || 1));
  for (let i = 0; i < attempts; i += 1) {
    if (isCancelled(runCtx)) return { ok: false, status: "cancel", present: sawExpected, error: lastError };
    const out = furnace.outputItem?.();
    if (!outputSlotMatchesExpected(out, outputId, expectedName, mcData)) {
      return { ok: false, present: sawExpected, error: lastError };
    }
    sawExpected = true;
    try {
      await furnace.takeOutput();
      return { ok: true, present: true, error: null };
    } catch (e) {
      lastError = e;
      const waited = await waitTicks(bot, 2, runCtx);
      if (!waited) return { ok: false, status: "cancel", present: sawExpected, error: lastError };
    }
  }
  return { ok: false, present: sawExpected, error: lastError };
}

async function waitForFurnaceOutput(furnace, outputId, outputName, timeoutMs, runCtx, mcData) {
  const expectedName = normalizeItemName(outputName || "");
  const started = Date.now();
  const maxWaitMs = Math.max(1000, Number(timeoutMs || 12000));
  while (Date.now() - started < maxWaitMs) {
    if (isCancelled(runCtx)) return false;
    const out = furnace.outputItem?.();
    if (outputSlotMatchesExpected(out, outputId, expectedName, mcData)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function canonicalAutoAcquireFuelName(name) {
  const normalized = normalizeItemName(name);
  if (!normalized) return null;
  if (normalized === "log" || /(_log|_stem|_hyphae)$/.test(normalized)) return "log";
  if (normalized === "planks" || /_planks$/.test(normalized)) return "planks";
  if (normalized === "stick") return "stick";
  if (normalized === "coal") return "coal";
  return null;
}

function orderedAutoAcquireFuelCandidates(preferred = []) {
  const skip = new Set(["charcoal", "coal_block", "lava_bucket", "blaze_rod", "dried_kelp_block"]);
  const out = [];
  const seen = new Set();
  for (const candidate of preferred || []) {
    const normalized = normalizeItemName(candidate);
    if (!normalized || skip.has(normalized)) continue;
    const canonical = canonicalAutoAcquireFuelName(normalized);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

function fuelCandidateExcluded(name, excluded = null) {
  if (!(excluded instanceof Set) || excluded.size < 1) return false;
  const canonical = canonicalAutoAcquireFuelName(name);
  const normalized = normalizeItemName(name);
  return (canonical && excluded.has(canonical)) || (!!normalized && excluded.has(normalized));
}

function summarizePreferredFuelInventory(bot, preferred = [], maxEntries = 4) {
  const ordered = orderedAutoAcquireFuelCandidates(preferred);
  const summary = [];
  for (const fuelName of ordered) {
    const count = Math.max(0, inventoryCount(bot, fuelName));
    if (count > 0) summary.push(`${fuelName}:${count}`);
    if (summary.length >= Math.max(1, Number(maxEntries || 4))) break;
  }
  if (!summary.length) return "none";
  return summary.join(",");
}

function isMissingInventoryTransferError(detail) {
  return /can't find .* in slots/i.test(String(detail || ""));
}

async function smeltRecipeStep(bot, args, cfg, runCtx, log, ctx) {
  const item = normalizeItemName(args?.item);
  const count = Math.max(1, Number(args?.count || 1));
  const station = normalizeItemName(args?.station || "furnace");
  const ingredients = Array.isArray(args?.ingredients)
    ? args.ingredients.map((ing) => ({ name: normalizeItemName(ing?.name), count: Math.max(1, Number(ing?.count || 1)) })).filter((ing) => !!ing.name)
    : [];
  const inputName = normalizeItemName(args?.input || ingredients[0]?.name || "");

  if (!item || !inputName) {
    return {
      ok: false,
      code: "invalid_smelt_recipe",
      reason: "invalid smelt recipe",
      nextNeed: "provide input item",
      recoverable: false
    };
  }

  const fuelCfg = fuelPlan(cfg, count);
  log({
    type: "fuel_plan_start",
    item,
    count,
    station,
    requiredFuelUnits: fuelCfg.requiredFuelUnits,
    preferred: fuelCfg.preferred
  });

  const ensured = await ensureStation(bot, station, cfg, runCtx, log, ctx);
  if (!ensured.ok) return ensured;
  const stationBlock = ctx.stations?.[station] || ensured?.data || null;
  if (!stationBlock) {
    return {
      ok: false,
      code: "station_unavailable",
      reason: `need ${station} nearby`,
      nextNeed: `place ${station}`,
      recoverable: false
    };
  }

  const mcData = require("minecraft-data")(bot.version);
  const inputInfo = mcData.itemsByName?.[inputName];
  const outputInfo = mcData.itemsByName?.[item];
  if (!inputInfo || !outputInfo) {
    return {
      ok: false,
      code: "unknown_item",
      reason: `unknown smelt item ${!inputInfo ? inputName : item}`,
      nextNeed: "valid item name",
      recoverable: false
    };
  }

  let furnace = null;
  try {
    furnace = await bot.openFurnace(stationBlock);
  } catch (e) {
    return {
      ok: false,
      code: "station_open_failed",
      reason: `failed to open ${station}`,
      nextNeed: `move closer to ${station}`,
      recoverable: true
    };
  }

  try {
    const targetCount = stepTargetInventoryCount(bot, item, count);
    let loops = 0;
    let lastProgressAt = Date.now();
    let lastStateChangeAt = Date.now();
    let lastStateSignature = "";
    const configuredSmeltWaitMs = Math.max(0, Number(cfg.smeltWaitTimeoutMs || 0));
    const smeltNoStateChangeMs = Math.max(1000, Number(cfg.smeltNoStateChangeMs || 40000));
    const smeltTransferRetryLimit = Math.max(1, Number(cfg.smeltTransferRetryLimit || 10));
    const smeltInputTransferRetryLimit = Math.max(1, Number(cfg.smeltInputTransferRetryLimit || 6));
    let knownInputBuffer = 0;
    let knownFuelOpsBuffer = 0;
    let takeOutputFailStreak = 0;
    let fuelTransferRetries = 0;
    let inputTransferRetries = 0;
    const rejectedFuelCandidates = new Set();
    let pendingClaimedOutput = 0;
    let lastObservedOutputCount = Math.max(0, inventoryCount(bot, item));

    const effectiveOutputCount = () => {
      const observed = Math.max(0, inventoryCount(bot, item));
      if (pendingClaimedOutput > 0 && observed > lastObservedOutputCount) {
        const reflected = observed - lastObservedOutputCount;
        pendingClaimedOutput = Math.max(0, pendingClaimedOutput - reflected);
      }
      lastObservedOutputCount = observed;
      return observed + pendingClaimedOutput;
    };

    const reconcileClaimedOutputToInventory = async (observedBeforeClaim, phase = "claim") => {
      const awaitedGain = await waitForInventoryGain(bot, item, observedBeforeClaim, runCtx, 12);
      if (awaitedGain?.status === "cancel") return { status: "cancel", gained: 0 };
      const gained = Math.max(0, Number(awaitedGain?.gained || 0));
      if (gained <= 0) {
        pendingClaimedOutput += 1;
        log({
          type: "smelt_output_claim_pending_inventory",
          item,
          station,
          phase,
          pendingClaimedOutput
        });
      } else if (pendingClaimedOutput > 0) {
        pendingClaimedOutput = Math.max(0, pendingClaimedOutput - gained);
      }
      effectiveOutputCount();
      return { status: "ok", gained };
    };

    const acquireFuelCandidate = async (missingOps, options = {}) => {
      const excludedFuelNames = options?.excludedFuelNames instanceof Set ? options.excludedFuelNames : null;
      const fullPreferred = Array.isArray(fuelCfg.preferred) ? fuelCfg.preferred : [];
      const filteredPreferred = excludedFuelNames
        ? fullPreferred.filter((name) => !fuelCandidateExcluded(name, excludedFuelNames))
        : fullPreferred.slice();
      const primaryPreferred = filteredPreferred.length ? filteredPreferred : fullPreferred;
      const fallbackPreferred = filteredPreferred.length && filteredPreferred.length < fullPreferred.length
        ? fullPreferred
        : [];
      const pickFuelFromInventory = (minSmelts) => {
        const direct = findFuelInventoryItem(bot, primaryPreferred, { minSmelts });
        if (direct) return direct;
        if (fallbackPreferred.length) {
          return findFuelInventoryItem(bot, fallbackPreferred, { minSmelts });
        }
        return null;
      };

      let fuelItem = pickFuelFromInventory(missingOps || 1)
        || pickFuelFromInventory(1);
      if (fuelItem || cfg.autoAcquireSmeltFuel === false) return fuelItem;
      const orderedCandidates = orderedAutoAcquireFuelCandidates(primaryPreferred);
      for (const fuelName of orderedCandidates) {
        const neededFuelItems = Math.max(1, requiredFuelItemCount(fuelName, missingOps || 1));
        let ensuredFuel = null;
        if (fuelName === "coal") {
          ensuredFuel = await gatherBlockStep(
            bot,
            {
              item: "coal",
              count: neededFuelItems,
              blockNames: ["coal_ore", "deepslate_coal_ore"],
              preferredBlocks: ["coal_ore", "deepslate_coal_ore"]
            },
            cfg,
            runCtx,
            log
          );
        } else {
          const targetFuel = inventoryCount(bot, fuelName) + neededFuelItems;
          ensuredFuel = await ensureItem(bot, fuelName, targetFuel, cfg, runCtx, log, ctx);
        }
        const normalizedFuel = normalizeStepResult(ensuredFuel, "smelt_fuel_auto_acquire_failed");
        if (normalizedFuel.status === "cancel") return normalizedFuel;
        if (!normalizedFuel.ok) continue;
        fuelItem = pickFuelFromInventory(missingOps || 1)
          || pickFuelFromInventory(1);
        if (fuelItem) break;
      }
      return fuelItem;
    };

    while (true) {
      const currentOutputCount = effectiveOutputCount();
      if (currentOutputCount >= targetCount) break;
      if (isCancelled(runCtx)) return { ok: false, status: "cancel" };
      if (loops++ > 384) {
        return {
          ok: false,
          code: "smelt_loop_limit",
          reason: `smelt loop limit for ${item}`,
          nextNeed: `check furnace state for ${item}`,
          recoverable: false
        };
      }

      const beforeOutputCount = currentOutputCount;
      const observedBeforeClaim = Math.max(0, inventoryCount(bot, item));
      const claimed = await tryTakeExpectedFurnaceOutput(
        bot,
        furnace,
        outputInfo.id,
        outputInfo.name,
        runCtx,
        mcData,
        3
      );
      if (claimed?.status === "cancel") return { ok: false, status: "cancel" };
      if (claimed?.ok) {
        takeOutputFailStreak = 0;
        knownInputBuffer = Math.max(0, knownInputBuffer - 1);
        knownFuelOpsBuffer = Math.max(0, knownFuelOpsBuffer - 1);
        fuelTransferRetries = 0;
        inputTransferRetries = 0;
        const reconciledClaim = await reconcileClaimedOutputToInventory(observedBeforeClaim, "claim");
        if (reconciledClaim?.status === "cancel") return { ok: false, status: "cancel" };
        lastProgressAt = Date.now();
        lastStateChangeAt = lastProgressAt;
        reportProgress(runCtx, `claimed smelt output ${item}`, {
          stepAction: "smelt_recipe",
          progressKind: "state",
          msg: `claimed smelt output ${item}`
        });
        const waited = await waitTicks(bot, 2, runCtx);
        if (!waited) return { ok: false, status: "cancel" };
        continue;
      }
      if (claimed?.present) {
        takeOutputFailStreak += 1;
        log({
          type: "smelt_take_output_retry",
          item,
          station,
          streak: takeOutputFailStreak
        });
        if (takeOutputFailStreak > 12) {
          return {
            ok: false,
            code: "smelt_take_output_failed",
            reason: `failed taking smelted ${item}`,
            nextNeed: "clear inventory space",
            recoverable: false
          };
        }
        const waitedRetry = await waitTicks(bot, 4, runCtx);
        if (!waitedRetry) return { ok: false, status: "cancel" };
        continue;
      }
      takeOutputFailStreak = 0;

      const outputSlot = furnace.outputItem?.();
      const outputSlotType = Number(outputSlot?.type);
      const outputSlotName = normalizeItemName(outputSlot?.name || mcData.items?.[outputSlotType]?.name || "");
      if (outputSlot && Number(outputSlot?.count || 0) > 0) {
        return {
          ok: false,
          code: "smelt_output_blocked",
          reason: `furnace output slot blocked with ${outputSlotName || "unknown item"}`,
          nextNeed: `clear furnace output for ${station}`,
          recoverable: false
        };
      }

      const remainingOutputs = Math.max(0, targetCount - effectiveOutputCount());
      if (remainingOutputs <= 0) break;

      const inputSlot = furnace.inputItem?.();
      const inputSlotType = Number(inputSlot?.type);
      const inputSlotCount = Math.max(0, Number(inputSlot?.count || 0));
      const inputSlotName = normalizeItemName(inputSlot?.name || mcData.items?.[inputSlotType]?.name || "");
      const inputSlotMatches = !!inputSlot
        && inputSlotCount > 0
        && (inputSlotType === inputInfo.id || inputSlotName === inputName);
      if (inputSlot && Number(inputSlot?.count || 0) > 0 && !inputSlotMatches) {
        return {
          ok: false,
          code: "smelt_input_blocked",
          reason: `furnace input slot occupied by ${inputSlotName || "unknown item"}`,
          nextNeed: `clear furnace input for ${station}`,
          recoverable: false
        };
      }

      const fuelSlot = furnace.fuelItem?.();
      const fuelSlotType = Number(fuelSlot?.type);
      const fuelSlotName = normalizeItemName(fuelSlot?.name || mcData.items?.[fuelSlotType]?.name || "");
      const fuelSlotCount = Math.max(0, Number(fuelSlot?.count || 0));
      const bufferedFuelOps = Math.max(
        Math.max(0, fuelSlotCount * Number(fuelSmeltValue(fuelSlotName) || 0)),
        knownFuelOpsBuffer
      );
      const inferredBufferedInput = Math.max(
        inputSlotMatches ? inputSlotCount : 0,
        knownInputBuffer,
        (inputSlotMatches && inputSlotCount > 0 && bufferedFuelOps > 0) ? inputSlotCount + 1 : 0
      );
      const missingInputOps = Math.max(0, remainingOutputs - inferredBufferedInput);
      const missingFuelOps = Math.max(0, remainingOutputs - bufferedFuelOps);
      const stateSignatureObj = {
        inputSlot: `${inputSlotName || "none"}:${inputSlotCount}`,
        fuelSlot: `${fuelSlotName || "none"}:${fuelSlotCount}`,
        outputSlot: `${outputSlotName || "none"}:${Math.max(0, Number(outputSlot?.count || 0))}`,
        invOutput: effectiveOutputCount(),
        invInput: inventoryCount(bot, inputName),
        invFuel: summarizePreferredFuelInventory(bot, fuelCfg.preferred)
      };
      const stateSignature = JSON.stringify(stateSignatureObj);
      if (stateSignature !== lastStateSignature) {
        lastStateSignature = stateSignature;
        lastStateChangeAt = Date.now();
        lastProgressAt = lastStateChangeAt;
        reportProgress(runCtx, `smelt state changed ${item}`, {
          stepAction: "smelt_recipe",
          progressKind: "state",
          msg: `smelt state changed ${item}`
        });
      } else if ((Date.now() - lastStateChangeAt) >= smeltNoStateChangeMs) {
        return {
          ok: false,
          code: "smelt_state_stalled",
          reason: `smelt state stalled for ${item} (${Date.now() - lastStateChangeAt}ms)`,
          nextNeed: `check furnace/input/fuel state: ${stateSignatureObj.inputSlot},${stateSignatureObj.fuelSlot},${stateSignatureObj.outputSlot}`,
          recoverable: false
        };
      }
      log({
        type: "smelt_state",
        item,
        station,
        loop: loops,
        remainingOutputs,
        slots: {
          input: { name: inputSlotName || null, count: inputSlotCount, matches: inputSlotMatches },
          fuel: {
            name: fuelSlotName || null,
            count: fuelSlotCount,
            burn: Number(fuelSmeltValue(fuelSlotName) || 0)
          },
          output: { name: outputSlotName || null, count: Math.max(0, Number(outputSlot?.count || 0)) }
        },
        buffers: {
          knownInputBuffer,
          bufferedInput: inferredBufferedInput,
          knownFuelOpsBuffer,
          bufferedFuelOps
        },
        missing: {
          inputOps: missingInputOps,
          fuelOps: missingFuelOps
        }
      });

      let fuelItem = null;
      if (missingFuelOps > 0) {
        fuelItem = await acquireFuelCandidate(missingFuelOps, {
          excludedFuelNames: rejectedFuelCandidates
        });
        if (fuelItem?.status === "cancel") return fuelItem;
      }
      if (!fuelItem && missingFuelOps > 0) {
        log({ type: "fuel_plan_fail", item, station, reason: "no_fuel_in_inventory" });
        return {
          ok: false,
          code: "smelt_no_fuel",
          reason: `need fuel for ${item}`,
          nextNeed: "get any furnace fuel (coal, log, planks, sticks)",
          recoverable: false
        };
      }

      if (missingFuelOps > 0 && fuelItem) {
        const fuelItemName = normalizeItemName(fuelItem?.name || mcData.items?.[Number(fuelItem?.type)]?.name || "");
        const fuelBurn = Math.max(0, Number(fuelSmeltValue(fuelItemName) || 0));
        const requiredFuelCount = requiredFuelItemCount(fuelItemName, missingFuelOps);
        const insertFuelCount = Math.max(
          1,
          Math.min(
            Number(fuelItem?.count || 0),
            Number.isFinite(requiredFuelCount) ? requiredFuelCount : Number(fuelItem?.count || 0)
          )
        );
        try {
          await furnace.putFuel(fuelItem.type ?? mcData.itemsByName[fuelItemName]?.id, null, insertFuelCount);
          fuelTransferRetries = 0;
          knownFuelOpsBuffer += Math.floor(insertFuelCount * (fuelBurn || 0));
          lastProgressAt = Date.now();
          lastStateChangeAt = lastProgressAt;
          reportProgress(runCtx, `loaded fuel ${fuelItemName || "fuel"} x${insertFuelCount}`, {
            stepAction: "smelt_recipe",
            progressKind: "state",
            msg: `loaded fuel ${fuelItemName || "fuel"}`
          });
          log({
            type: "smelt_fuel_batch",
            item,
            station,
            fuel: fuelItemName || null,
            inserted: insertFuelCount,
            missingFuelOps
          });
        } catch (e) {
          const detail = String(e?.message || e || "");
          fuelTransferRetries += 1;
          log({
            type: "smelt_transfer_retry",
            item,
            station,
            where: "put_fuel",
            retry: fuelTransferRetries,
            max: smeltTransferRetryLimit,
            error: detail
          });
          if (isMissingInventoryTransferError(detail) && cfg.autoAcquireSmeltFuel !== false) {
            const rejectedFuel = canonicalAutoAcquireFuelName(fuelItemName) || fuelItemName || null;
            if (rejectedFuel) {
              rejectedFuelCandidates.add(rejectedFuel);
              log({
                type: "smelt_fuel_rejected",
                item,
                station,
                fuel: rejectedFuel,
                reason: "missing_inventory_slots",
                retry: fuelTransferRetries
              });
            }
            await refreshStationInventoryCache(bot, cfg, log);
            const refreshedFuel = await acquireFuelCandidate(missingFuelOps, {
              excludedFuelNames: rejectedFuelCandidates
            });
            if (refreshedFuel?.status === "cancel") return refreshedFuel;
            if (refreshedFuel) {
              const refreshedFuelName = normalizeItemName(
                refreshedFuel?.name || mcData.items?.[Number(refreshedFuel?.type)]?.name || ""
              );
              if (refreshedFuelName && refreshedFuelName !== fuelItemName) {
                log({
                  type: "smelt_fuel_fallback",
                  item,
                  station,
                  from: fuelItemName || null,
                  to: refreshedFuelName
                });
                fuelTransferRetries = 0;
              }
            }
          }
          if (fuelTransferRetries > smeltTransferRetryLimit) {
            return {
              ok: false,
              code: "smelt_transfer_failed",
              reason: `failed to load furnace fuel for ${item}`,
              nextNeed: `fuel transfer failed: ${detail}`,
              recoverable: false
            };
          }
          const waitedFuelRetry = await waitTicks(bot, 2, runCtx);
          if (!waitedFuelRetry) return { ok: false, status: "cancel" };
          continue;
        }
      }

      if (missingInputOps > 0) {
        let availableInput = Math.max(0, inventoryCount(bot, inputName));
        if (availableInput < missingInputOps) {
          const targetInputCount = availableInput + (missingInputOps - availableInput);
          const ensuredInput = await ensureItem(bot, inputName, targetInputCount, cfg, runCtx, log, ctx);
          const normalizedInput = normalizeStepResult(ensuredInput, "smelt_input_missing");
          if (normalizedInput.status === "cancel") return normalizedInput;
          if (!normalizedInput.ok) return normalizedInput;
          availableInput = Math.max(0, inventoryCount(bot, inputName));
        }
        if (availableInput < 1) {
          return {
            ok: false,
            code: "smelt_input_missing",
            reason: `need ${inputName}`,
            nextNeed: `acquire ${inputName}`,
            recoverable: false
          };
        }
        const inputInsertCount = Math.max(1, Math.min(availableInput, missingInputOps));
        try {
          await furnace.putInput(inputInfo.id, null, inputInsertCount);
          inputTransferRetries = 0;
          knownInputBuffer += inputInsertCount;
          lastProgressAt = Date.now();
          lastStateChangeAt = lastProgressAt;
          reportProgress(runCtx, `loaded input ${inputName} x${inputInsertCount}`, {
            stepAction: "smelt_recipe",
            progressKind: "state",
            msg: `loaded input ${inputName}`
          });
          log({
            type: "smelt_input_batch",
            item,
            station,
            inserted: inputInsertCount,
            remainingOutputs
          });
        } catch (e) {
          const detail = String(e?.message || e || "");
          inputTransferRetries += 1;
          log({
            type: "smelt_transfer_retry",
            item,
            station,
            where: "put_input",
            retry: inputTransferRetries,
            max: smeltInputTransferRetryLimit,
            error: detail
          });
          if (isMissingInventoryTransferError(detail)) {
            await refreshStationInventoryCache(bot, cfg, log);
            const refreshedRemainingOutputs = Math.max(0, targetCount - inventoryCount(bot, item));
            const refreshedInputSlot = furnace.inputItem?.();
            const refreshedInputType = Number(refreshedInputSlot?.type);
            const refreshedInputCount = Math.max(0, Number(refreshedInputSlot?.count || 0));
            const refreshedInputName = normalizeItemName(
              refreshedInputSlot?.name || mcData.items?.[refreshedInputType]?.name || ""
            );
            const refreshedInputMatches = !!refreshedInputSlot
              && refreshedInputCount > 0
              && (refreshedInputType === inputInfo.id || refreshedInputName === inputName);
            const refreshedFuelSlot = furnace.fuelItem?.();
            const refreshedFuelSlotType = Number(refreshedFuelSlot?.type);
            const refreshedFuelSlotName = normalizeItemName(
              refreshedFuelSlot?.name || mcData.items?.[refreshedFuelSlotType]?.name || ""
            );
            const refreshedFuelSlotCount = Math.max(0, Number(refreshedFuelSlot?.count || 0));
            const refreshedBufferedFuelOps = Math.max(
              Math.max(0, refreshedFuelSlotCount * Number(fuelSmeltValue(refreshedFuelSlotName) || 0)),
              knownFuelOpsBuffer
            );
            const refreshedBufferedInput = Math.max(
              refreshedInputMatches ? refreshedInputCount : 0,
              knownInputBuffer,
              (refreshedInputMatches && refreshedInputCount > 0 && refreshedBufferedFuelOps > 0)
                ? refreshedInputCount + 1
                : 0
            );
            if (refreshedBufferedInput >= refreshedRemainingOutputs) {
              inputTransferRetries = 0;
              knownInputBuffer = Math.max(knownInputBuffer, refreshedBufferedInput);
              log({
                type: "smelt_input_retry_deferred",
                item,
                station,
                reason: "input_already_buffered_or_inflight",
                remainingOutputs: refreshedRemainingOutputs,
                bufferedInput: refreshedBufferedInput
              });
              const waitedInputRetry = await waitTicks(bot, 2, runCtx);
              if (!waitedInputRetry) return { ok: false, status: "cancel" };
              continue;
            }
          }
          if (inputTransferRetries > smeltInputTransferRetryLimit) {
            return {
              ok: false,
              code: "smelt_transfer_failed",
              reason: `failed to load furnace input for ${item}`,
              nextNeed: `input transfer failed: ${detail}`,
              recoverable: false
            };
          }
          const waitedInputRetry = await waitTicks(bot, 2, runCtx);
          if (!waitedInputRetry) return { ok: false, status: "cancel" };
          continue;
        }
      }

      const waitedForTick = await waitTicks(bot, 4, runCtx);
      if (!waitedForTick) return { ok: false, status: "cancel" };

      const afterOutputCount = effectiveOutputCount();
      if (afterOutputCount > beforeOutputCount) {
        fuelTransferRetries = 0;
        inputTransferRetries = 0;
        lastProgressAt = Date.now();
        lastStateChangeAt = lastProgressAt;
        reportProgress(runCtx, `smelted ${item}`, {
          stepAction: "smelt_recipe",
          progressKind: "state",
          msg: `smelted ${item}`
        });
        continue;
      }

      const observedBeforeFollowupClaim = Math.max(0, inventoryCount(bot, item));
      const followupClaim = await tryTakeExpectedFurnaceOutput(
        bot,
        furnace,
        outputInfo.id,
        outputInfo.name,
        runCtx,
        mcData,
        2
      );
      if (followupClaim?.status === "cancel") return { ok: false, status: "cancel" };
      if (followupClaim?.ok) {
        takeOutputFailStreak = 0;
        knownInputBuffer = Math.max(0, knownInputBuffer - 1);
        knownFuelOpsBuffer = Math.max(0, knownFuelOpsBuffer - 1);
        fuelTransferRetries = 0;
        inputTransferRetries = 0;
        const reconciledClaim = await reconcileClaimedOutputToInventory(
          observedBeforeFollowupClaim,
          "followup"
        );
        if (reconciledClaim?.status === "cancel") return { ok: false, status: "cancel" };
        lastProgressAt = Date.now();
        lastStateChangeAt = lastProgressAt;
        reportProgress(runCtx, `claimed smelt output ${item}`, {
          stepAction: "smelt_recipe",
          progressKind: "state",
          msg: `claimed smelt output ${item}`
        });
        continue;
      }
      if (followupClaim?.present) {
        takeOutputFailStreak += 1;
        log({
          type: "smelt_take_output_retry",
          item,
          station,
          streak: takeOutputFailStreak
        });
        if (takeOutputFailStreak > 12) {
          return {
            ok: false,
            code: "smelt_take_output_failed",
            reason: `failed taking smelted ${item}`,
            nextNeed: "clear inventory space",
            recoverable: false
          };
        }
        const waitedRetry = await waitTicks(bot, 4, runCtx);
        if (!waitedRetry) return { ok: false, status: "cancel" };
        continue;
      }
      takeOutputFailStreak = 0;

      const freshRemaining = Math.max(0, targetCount - effectiveOutputCount());
      const waitBudgetMs = timeoutsDisabled(cfg)
        ? Number.POSITIVE_INFINITY
        : Math.max(
            configuredSmeltWaitMs,
            Math.min(900000, freshRemaining * 12000 + 15000),
            Math.max(4000, Number(cfg.reasoningStepTimeoutMs || 12000))
          );
      if (!timeoutsDisabled(cfg) && (Date.now() - lastProgressAt) > waitBudgetMs) {
        return {
          ok: false,
          code: "smelt_wait_timeout",
          reason: `smelt wait timeout for ${item}`,
          nextNeed: "check furnace fuel/input",
          recoverable: false
        };
      }
      reportProgress(runCtx, `smelting ${item} (${freshRemaining} left)`, {
        stepAction: "smelt_recipe",
        progressKind: "heartbeat",
        msg: `smelting ${item}`,
        remaining: freshRemaining
      });
      reportProgress(runCtx, `waiting furnace output ${item} (${freshRemaining} left)`, {
        stepAction: "smelt_recipe",
        progressKind: "heartbeat",
        msg: `waiting furnace output ${item}`,
        remaining: freshRemaining
      });
    }
  } finally {
    try {
      furnace?.close?.();
    } catch {}
  }

  return { ok: true };
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
  if (timeoutsDisabled(cfg)) return Number.MAX_SAFE_INTEGER;
  const configuredBase = Math.max(1000, Number(cfg.reasoningStepTimeoutMs || 12000));
  const rawStepTimeout = Number(step?.timeoutMs);
  const hasStepTimeout = Number.isFinite(rawStepTimeout) && rawStepTimeout > 0;
  const base = hasStepTimeout ? Math.max(1000, rawStepTimeout) : configuredBase;
  const hasExplicitOverride = hasStepTimeout && Math.floor(rawStepTimeout) !== Math.floor(configuredBase);

  if (step?.action === "gather_block") {
    if (hasExplicitOverride) return base;
    return Math.max(base, estimateGatherStepTimeoutMs(cfg));
  }

  if (step?.action === "ensure_station" || step?.action === "smelt_recipe" || step?.action === "station_recipe") {
    if (hasExplicitOverride) return base;
    const stationBudget = Math.max(
      Math.max(1000, Number(cfg.reasoningMoveTimeoutMs || 12000)),
      moveTimeoutForDistance(cfg, configuredStationSearchRadius(cfg))
    );
    const gatherBudget = estimateGatherStepTimeoutMs(cfg);
    const expanded = Math.min(180000, stationBudget + gatherBudget);
    return Math.max(base, expanded);
  }

  return base;
}

function configuredStepStallGuardMs(step, cfg = {}) {
  if (cfg.stepStallGuardEnabled === false) return null;
  const explicitMs = Number(cfg.stepStallGuardMs);
  if (Number.isFinite(explicitMs) && explicitMs > 0) {
    return Math.max(250, Math.floor(explicitMs));
  }

  const explicitSec = Number(cfg.stepStallGuardSec);
  if (Number.isFinite(explicitSec) && explicitSec > 0) {
    return Math.max(250, Math.floor(explicitSec * 1000));
  }
  const defaultMs = cfg.disableTimeouts === true
    ? 40000
    : Math.max(15000, Number(cfg.taskNoProgressTimeoutSec || 45) * 1000);
  const fromSec = defaultMs;

  let base = fromSec;
  if (step?.action === "gather_block") {
    // In disableTimeouts mode we still need fast anti-stall behavior.
    // Don't inflate gather guard to multi-minute estimates.
    if (cfg.disableTimeouts !== true) {
      base = Math.max(base, estimateGatherStepTimeoutMs(cfg));
    }
  } else if (step?.action === "smelt_recipe") {
    const outputs = Math.max(1, Number(step?.args?.count || 1));
    const smeltEstimate = Math.min(900000, outputs * 12000 + 15000);
    if (cfg.disableTimeouts !== true) {
      base = Math.max(base, smeltEstimate);
    }
  }
  return Math.min(300000, Math.max(1000, Math.floor(base)));
}

function makeProgressWrappedRunCtx(runCtx, markProgress) {
  if (!runCtx || typeof runCtx !== "object") return runCtx;
  return {
    ...runCtx,
    reportProgress(message, extra = {}) {
      if (isStateProgress(extra)) markProgress();
      if (typeof runCtx.reportProgress === "function") {
        return runCtx.reportProgress(message, extra);
      }
      return undefined;
    },
    setStep(stepId, stepAction, extra = {}) {
      if (isStateProgress(extra)) markProgress();
      if (typeof runCtx.setStep === "function") {
        return runCtx.setStep(stepId, stepAction, extra);
      }
      return undefined;
    }
  };
}

async function executeGoalPlan(bot, goalPlan, cfg, runCtx, log, progress = null) {
  if (!goalPlan?.ok || !Array.isArray(goalPlan.steps)) {
    return normalizeCraftResult("fail", "invalid goal plan", "rebuild plan");
  }

  const timeoutSec = goalPlan?.constraints?.timeoutSec || cfg.autoGatherTimeoutSec || cfg.craftJobTimeoutSec || 90;
  const deadline = Date.now() + timeoutSec * 1000;
  const ctx = {
    stations: {},
    relocationCount: 0,
    relocationByItem: {}
  };

  for (const step of goalPlan.steps) {
    if (isCancelled(runCtx)) return { status: "cancel" };
    if (!timeoutsDisabled(cfg) && Date.now() > deadline) return { status: "timeout", reason: "goal timeout", recoverable: false };
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
    if (step.action === "ensure_station" || step.action === "smelt_recipe" || step.action === "station_recipe") {
      log({
        type: "station_step_start",
        goalId: goalPlan.goalId,
        stepId: step.id || null,
        action: step.action,
        station: step.args?.station || null
      });
    }
    log({
      type: "step_progress",
      taskId: runCtx?.id || null,
      goalId: goalPlan.goalId,
      stepId: step.id || null,
      action: step.action || null,
      msg: `start ${step.action}`
    });
    const stepRunner = async (activeRunCtx) => {
      if (step.action === "ensure_station") return ensureStation(bot, step.args?.station, cfg, activeRunCtx, log, ctx);
      if (step.action === "craft_recipe") return craftRecipeStep(bot, step.args, cfg, activeRunCtx, log, ctx);
      if (step.action === "station_recipe") return stationRecipeStep(bot, step.args, cfg, activeRunCtx, log, ctx);
      if (step.action === "gather_block") return gatherBlockStep(bot, step.args, cfg, activeRunCtx, log);
      if (step.action === "harvest_crop") return harvestCropStep(bot, step.args, cfg, activeRunCtx, log);
      if (step.action === "kill_mob_drop") return killMobDropStep(bot, step.args, cfg, activeRunCtx, log);
      if (step.action === "smelt_recipe") return smeltRecipeStep(bot, step.args, cfg, activeRunCtx, log, ctx);
      return { ok: false, code: "unsupported_step", reason: `unsupported step ${step.action}`, nextNeed: "update planner", recoverable: false };
    };

    const maxRelocations = Math.max(0, Number(cfg.missingResourceMaxRelocations ?? 3));
    const maxStallRetries = Math.max(0, Number(cfg.stepStallRetryCount || 2));
    let result = null;
    let localAttempts = 0;
    let stallRetries = 0;
    while (true) {
      localAttempts += 1;
      const stepTimeoutMs = effectiveStepTimeoutMs(step, cfg);
      const stallGuardMs = configuredStepStallGuardMs(step, cfg);
      const timeoutHandle = { id: null };
      const stallHandle = { id: null, resolved: false };
      const timeoutState = { cancelled: false };
      let stepLastProgressAt = Date.now();
      const markStepProgress = () => {
        stepLastProgressAt = Date.now();
      };
      const baseStepRunCtx = runCtx
        ? {
            ...runCtx,
            isCancelled() {
              return timeoutState.cancelled || (typeof runCtx.isCancelled === "function" ? runCtx.isCancelled() : !!runCtx.cancelled);
            }
          }
        : {
            isCancelled() {
              return timeoutState.cancelled;
            }
          };
      const stepRunCtx = makeProgressWrappedRunCtx(baseStepRunCtx, markStepProgress);
      const stepCorrectionPromise = runStepWithCorrection(
        step.action,
        () => stepRunner(stepRunCtx),
        { bot, cfg, runCtx: stepRunCtx, log },
        step.retryPolicy || {}
      );

      const guardPromises = [];
      if (!timeoutsDisabled(cfg)) {
        guardPromises.push(new Promise((resolve) => {
          timeoutHandle.id = setTimeout(() => {
            timeoutState.cancelled = true;
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
        }));
      }

      if (Number.isFinite(stallGuardMs) && stallGuardMs > 0) {
        guardPromises.push(new Promise((resolve) => {
          const tickMs = Math.max(250, Math.min(1000, Math.floor(stallGuardMs / 4)));
          stallHandle.id = setInterval(() => {
            if (stallHandle.resolved) return;
            const inactiveMs = Date.now() - stepLastProgressAt;
            if (inactiveMs < stallGuardMs) return;
            stallHandle.resolved = true;
            timeoutState.cancelled = true;
            try {
              bot.pathfinder?.setGoal?.(null);
              bot.clearControlStates?.();
            } catch {}
            log({
              type: "step_stall",
              taskId: runCtx?.id || null,
              goalId: goalPlan.goalId,
              stepId: step.id || null,
              action: step.action || null,
              stallMs: stallGuardMs,
              inactivityMs: inactiveMs
            });
            resolve({
              ok: false,
              code: "step_stalled",
              reason: `step stalled: ${step.action}`,
              nextNeed: "retrying current step",
              recoverable: true
            });
          }, tickMs);
        }));
      }

      let stepError = null;
      try {
        if (guardPromises.length === 0) {
          result = await stepCorrectionPromise;
        } else {
          result = await Promise.race([
            stepCorrectionPromise,
            ...guardPromises
          ]);
        }
      } catch (err) {
        stepError = err;
      } finally {
        if (timeoutHandle.id) clearTimeout(timeoutHandle.id);
        stallHandle.resolved = true;
        if (stallHandle.id) clearInterval(stallHandle.id);
      }
      if (stepError) {
        const detail = String(stepError?.message || stepError || "step exception");
        log({
          type: "step_exception",
          taskId: runCtx?.id || null,
          goalId: goalPlan.goalId,
          stepId: step.id || null,
          action: step.action || null,
          error: detail
        });
        result = {
          ok: false,
          code: "step_exception",
          reason: `step exception: ${step.action}`,
          nextNeed: detail,
          recoverable: false
        };
      }

      if (!result?.ok && result?.code === "step_stalled") {
        stallRetries += 1;
        log({
          type: "step_retry",
          taskId: runCtx?.id || null,
          goalId: goalPlan.goalId,
          stepId: step.id || null,
          action: step.action || null,
          reason: "step_stalled",
          retry: stallRetries,
          max: maxStallRetries
        });
        reportProgress(runCtx, `retry ${step.action} after stall`, {
          stepId: step.id || null,
          stepAction: step.action || null,
          attempt: stallRetries
        });
        if (stallRetries <= maxStallRetries) {
          continue;
        }
        result = {
          ok: false,
          code: "step_stalled",
          reason: `step stalled after retries: ${step.action}`,
          nextNeed: "move to open area",
          recoverable: false
        };
      }

      if (!result?.ok && result?.code === "resource_not_loaded" && String(cfg.missingResourcePolicy || "ask_before_move").toLowerCase() === "auto_relocate") {
        const item = normalizeItemName(result?.meta?.item || step.args?.item || goalPlan.item || "");
        const itemRelocations = Number(ctx.relocationByItem[item] || 0);
        if (ctx.relocationCount >= maxRelocations || itemRelocations >= maxRelocations) {
          result = {
            ok: false,
            code: "resource_not_loaded",
            reason: result?.reason || `no ${item} source nearby`,
            nextNeed: `move to area with ${item}`,
            recoverable: false,
            meta: result?.meta || { item }
          };
          break;
        }

        const relocation = await autoRelocateForResource(
          bot,
          item,
          cfg,
          runCtx,
          log,
          { relocationCount: itemRelocations }
        );
        if (!relocation.ok) {
          result = {
            ok: false,
            code: relocation.code || "relocate_failed",
            reason: relocation.reason || `failed to relocate for ${item}`,
            nextNeed: relocation.nextNeed || `move to area with ${item}`,
            recoverable: false,
            meta: { item }
          };
          break;
        }

        ctx.relocationCount += 1;
        ctx.relocationByItem[item] = itemRelocations + 1;
        reportProgress(runCtx, `relocated for ${item} ring ${relocation.ring}`, {
          stepAction: step.action || null,
          msg: `relocated for ${item}`
        });
        if (typeof progress === "function") {
          progress(`relocated for ${item}`, {
            stepId: step.id || null,
            stepAction: step.action || null
          });
        }
        if (localAttempts < (maxRelocations + 1)) {
          continue;
        }
      }
      break;
    }

    if (result?.status === "cancel") return { status: "cancel" };
    if (!result?.ok) {
      if (step.action === "ensure_station" || step.action === "smelt_recipe" || step.action === "station_recipe") {
        log({
          type: "station_step_fail",
          goalId: goalPlan.goalId,
          stepId: step.id || null,
          action: step.action,
          station: step.args?.station || null,
          code: result?.code || "step_failed",
          reason: result?.reason || "step failed"
        });
      }
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

    if (step.action === "ensure_station" || step.action === "smelt_recipe" || step.action === "station_recipe") {
      log({
        type: "station_step_ok",
        goalId: goalPlan.goalId,
        stepId: step.id || null,
        action: step.action,
        station: step.args?.station || null
      });
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

  const pulledGoalOutput = await retrieveNearbyStationItems(bot, goalPlan.item, goalPlan.count, cfg, runCtx, log);
  if (pulledGoalOutput?.status === "cancel") return { status: "cancel" };
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
    if (!timeoutsDisabled(cfg) && Date.now() > deadline) {
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
    selectBestCraftRecipe,
    configuredStepStallGuardMs
  }
};
