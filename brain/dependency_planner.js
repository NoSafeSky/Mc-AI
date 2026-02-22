const { buildCapabilitySnapshot, normalizeItemName } = require("./knowledge");
const { getAcquisitionOptions } = require("./acquisition_registry");
const { buildRecipeDb } = require("./recipe_db");
const {
  normalizePlanningItem,
  equivalentInventoryConsume
} = require("./item_equivalence");

let goalSeq = 0;
const loggedRecipeDbVersions = new Set();

function nextGoalId() {
  goalSeq += 1;
  return `goal_${Date.now()}_${goalSeq}`;
}

function cloneInventory(inv = {}) {
  return JSON.parse(JSON.stringify(inv));
}

function toCount(n, fallback = 1, max = 999) {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  const floored = Math.floor(value);
  if (!Number.isFinite(max) || max <= 0) return floored;
  return Math.min(max, floored);
}

function toLimit(n, fallback) {
  const value = Number(n);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function addStep(ctx, action, args, retryPolicy = null, timeoutMs = null) {
  const step = {
    id: `${ctx.goalId}_s${ctx.steps.length + 1}`,
    action,
    args: args || {},
    retryPolicy: retryPolicy || {},
    timeoutMs: timeoutMs || ctx.cfg.reasoningStepTimeoutMs || 12000
  };
  ctx.steps.push(step);
  return step;
}

function getInv(ctx, item) {
  return Number(ctx.virtualInventory[item] || 0);
}

function addInv(ctx, item, count) {
  ctx.virtualInventory[item] = getInv(ctx, item) + toCount(count, 0);
}

function consumeInv(ctx, item, count) {
  const need = toCount(count);
  const result = equivalentInventoryConsume(ctx.virtualInventory, item, need, ctx.cfg || {});
  if (result.consumed?.length && typeof ctx.log === "function") {
    ctx.log({
      type: "equiv_inventory_consume",
      item,
      requested: need,
      consumed: result.consumed
    });
  }
  return result;
}

function fail(code, reason, nextNeed = null) {
  return { ok: false, code, reason, nextNeed };
}

function inventorySignature(inventory = {}, cap = 30) {
  return Object.entries(inventory || {})
    .filter(([, count]) => Number(count || 0) > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, cap)
    .map(([name, count]) => `${name}:${count}`)
    .join("|");
}

function snapshotContext(ctx) {
  return {
    virtualInventory: cloneInventory(ctx.virtualInventory),
    stepCount: ctx.steps.length,
    rootNeeds: Array.isArray(ctx.rootNeeds) ? [...ctx.rootNeeds] : []
  };
}

function restoreContext(ctx, snapshot) {
  ctx.virtualInventory = snapshot.virtualInventory;
  ctx.steps.length = snapshot.stepCount;
  ctx.rootNeeds = snapshot.rootNeeds;
}

function setRootNeeds(ctx, option, item, count) {
  if (ctx.rootNeeds.length > 0) return;
  if (Array.isArray(option.ingredients) && option.ingredients.length) {
    ctx.rootNeeds = option.ingredients.map((ing) => ({ item: ing.name, count: ing.count }));
    if (option.station && option.station !== "inventory") {
      ctx.rootNeeds.push({ station: option.station });
    }
    return;
  }
  ctx.rootNeeds = [{ item, count }];
  if (option.station && option.station !== "inventory") {
    ctx.rootNeeds.push({ station: option.station });
  }
}

function checkBudget(ctx) {
  if (Date.now() - ctx.startedAt > ctx.timeoutMs) {
    if (!ctx.budgetExhaustedLogged) {
      ctx.log({
        type: "planner_budget_exhausted",
        goalId: ctx.goalId,
        reason: "timeout",
        elapsedMs: Date.now() - ctx.startedAt,
        nodeCount: ctx.nodeCount,
        maxNodes: ctx.maxNodes,
        timeoutMs: ctx.timeoutMs
      });
      ctx.budgetExhaustedLogged = true;
    }
    return fail("dependency_plan_timeout", "dependency planner timeout", "reduce request scope");
  }
  if (ctx.nodeCount > ctx.maxNodes) {
    if (!ctx.budgetExhaustedLogged) {
      ctx.log({
        type: "planner_budget_exhausted",
        goalId: ctx.goalId,
        reason: "node_limit",
        elapsedMs: Date.now() - ctx.startedAt,
        nodeCount: ctx.nodeCount,
        maxNodes: ctx.maxNodes,
        timeoutMs: ctx.timeoutMs
      });
      ctx.budgetExhaustedLogged = true;
    }
    return fail("dependency_node_limit", `dependency node limit exceeded at ${ctx.currentItem || "unknown"}`);
  }
  return null;
}

function pruneOptions(item, options, ctx) {
  const originalLength = options.length;
  let out = options;

  if (ctx.variantCap > 0 && out.length > ctx.variantCap) {
    out = out.slice(0, ctx.variantCap);
    ctx.log({
      type: "planner_variant_pruned",
      goalId: ctx.goalId,
      item,
      from: originalLength,
      to: out.length,
      reason: "variant_cap"
    });
  }

  if (ctx.beamWidth > 0 && out.length > ctx.beamWidth) {
    const from = out.length;
    out = out.slice(0, ctx.beamWidth);
    ctx.log({
      type: "planner_variant_pruned",
      goalId: ctx.goalId,
      item,
      from,
      to: out.length,
      reason: "beam_width"
    });
  }

  return out;
}

function memoKey(ctx, item, missing, depth) {
  return `${item}|${missing}|${depth}|${inventorySignature(ctx.virtualInventory, 24)}`;
}

function optionSortKey(option) {
  const total = Number(option.cost || 0) + Number(option.compatibilityScore || 0);
  return `${String(total).padStart(8, "0")}|${option.provider || ""}|${option.variantId || ""}`;
}

function planWithOption(ctx, item, missing, option, depth, stack) {
  if (option.provider === "unsupported_source") {
    return fail("unsupported_acquisition", `unsupported acquisition for ${item}`, `acquire ${item} manually`);
  }

  if (option.provider === "from_inventory") {
    const remainder = consumeInv(ctx, item, missing).remainder;
    if (remainder > 0) return fail("inventory_mismatch", `need ${item}`, `collect ${item}`);
    return { ok: true };
  }

  if (option.provider === "craft_recipe" || option.provider === "station_recipe") {
    for (const ingredient of option.ingredients || []) {
      const planned = planItem(ctx, ingredient.name, ingredient.count, depth + 1, stack);
      if (!planned.ok) return planned;
    }

    if (option.station && option.station !== "inventory") {
      if (option.station === "crafting_table" && item !== "crafting_table") {
        const nearby = !!ctx.snapshot.nearbyStations?.crafting_table?.available;
        if (!nearby) {
          const tablePlanned = planItem(ctx, "crafting_table", 1, depth + 1, stack);
          if (!tablePlanned.ok) return tablePlanned;
        }
      }
      addStep(ctx, "ensure_station", { station: option.station });
    }

    const stepAction = option.provider === "station_recipe" ? "station_recipe" : "craft_recipe";
    addStep(ctx, stepAction, {
      item,
      count: missing,
      station: option.station || "inventory",
      processType: option.processType || "craft",
      variantId: option.variantId || null,
      outputItem: option.outputItem || item,
      ingredients: option.ingredients || []
    });

    addInv(ctx, item, Number(option.outputCount || 1) * Number(option.runs || 1));
    const left = consumeInv(ctx, item, missing).remainder;
    if (left > 0) return fail("craft_yield_shortfall", `need ${item}`, `acquire ${item}`);
    return { ok: true };
  }

  if (option.provider === "smelt_recipe") {
    for (const ingredient of option.ingredients || []) {
      const planned = planItem(ctx, ingredient.name, ingredient.count, depth + 1, stack);
      if (!planned.ok) return planned;
    }

    addStep(ctx, "ensure_station", { station: option.station || "furnace" });
    addStep(ctx, "smelt_recipe", {
      item,
      count: missing,
      station: option.station || "furnace",
      processType: "smelt",
      variantId: option.variantId || null,
      ingredients: option.ingredients || [],
      input: option.input || option.ingredients?.[0]?.name || null,
      inputCount: option.inputCount || option.ingredients?.[0]?.count || missing
    });
    addInv(ctx, item, Number(option.outputCount || 1) * Number(option.runs || 1));
    const left = consumeInv(ctx, item, missing).remainder;
    if (left > 0) return fail("smelt_yield_shortfall", `need ${item}`, `smelt ${item}`);
    return { ok: true };
  }

  if (option.provider === "gather_block") {
    addStep(ctx, "gather_block", {
      item,
      count: missing,
      blockNames: option.blockNames || [item],
      preferredBlocks: option.preferredBlocks || option.blockNames || [item],
      toolRequirement: option.toolRequirement || null
    });
    addInv(ctx, item, missing);
    const left = consumeInv(ctx, item, missing).remainder;
    if (left > 0) return fail("gather_yield_shortfall", `need ${item}`, `gather ${item}`);
    return { ok: true };
  }

  if (option.provider === "harvest_crop") {
    addStep(ctx, "harvest_crop", {
      item,
      count: missing,
      cropBlocks: option.cropBlocks || []
    });
    addInv(ctx, item, missing);
    const left = consumeInv(ctx, item, missing).remainder;
    if (left > 0) return fail("harvest_yield_shortfall", `need ${item}`, `harvest ${item}`);
    return { ok: true };
  }

  if (option.provider === "kill_mob_drop") {
    addStep(ctx, "kill_mob_drop", {
      item,
      count: missing,
      mobs: option.mobs || []
    });
    addInv(ctx, item, missing);
    const left = consumeInv(ctx, item, missing).remainder;
    if (left > 0) return fail("drop_yield_shortfall", `need ${item}`, `hunt for ${item}`);
    return { ok: true };
  }

  return fail("unsupported_provider", `unsupported provider for ${item}`, `acquire ${item}`);
}

function planItem(ctx, itemName, count, depth, stack = []) {
  const rawItem = normalizeItemName(itemName);
  const item = normalizePlanningItem(rawItem, ctx.cfg || {});
  if (!item) return fail("invalid_item", "invalid item name");
  if (stack.includes(item)) {
    return fail("dependency_cycle", `dependency cycle detected at ${item}`, `acquire ${item} manually`);
  }
  if (depth > ctx.maxDepth) return fail("dependency_depth_limit", `dependency depth exceeded at ${item}`);

  ctx.currentItem = item;
  ctx.nodeCount += 1;
  const budgetFailure = checkBudget(ctx);
  if (budgetFailure) return budgetFailure;

  const consumed = consumeInv(ctx, item, count);
  const missing = consumed.remainder;
  if (missing <= 0) {
    if (consumed.usedEquivalent) {
      ctx.log({
        type: "equiv_need_resolved",
        item,
        count,
        consumed: consumed.consumed || []
      });
    }
    ctx.log({ type: "need_satisfied_inventory", item, count });
    return { ok: true };
  }

  const key = memoKey(ctx, item, missing, depth);
  if (ctx.failureMemo.has(key)) {
    return { ...ctx.failureMemo.get(key) };
  }

  const optionCtx = {
    bot: ctx.bot,
    mcData: ctx.mcData,
    cfg: ctx.cfg,
    snapshot: {
      ...ctx.snapshot,
      inventory: ctx.virtualInventory
    },
    log: ctx.log
  };

  ctx.log({ type: "dependency_expand", item, count: missing, depth });
  let options = getAcquisitionOptions(item, missing, optionCtx);
  options = options.slice().sort((a, b) => optionSortKey(a).localeCompare(optionSortKey(b)));
  options = pruneOptions(item, options, ctx);

  let bestFailure = null;
  const nextStack = [...stack, item];

  for (let i = 0; i < options.length; i += 1) {
    const option = options[i];
    ctx.log({
      type: "dependency_choice",
      item,
      count: missing,
      optionIndex: i,
      provider: option.provider,
      station: option.station || null,
      processType: option.processType || null
    });
    if (option.provider === "craft_recipe" || option.provider === "smelt_recipe" || option.provider === "station_recipe") {
      ctx.log({
        type: "recipe_variant_choice",
        item,
        variantId: option.variantId || null,
        processType: option.processType || null,
        station: option.station || null,
        compatibilityScore: Number(option.compatibilityScore || 0),
        ingredients: option.ingredients || []
      });
    }

    const snap = snapshotContext(ctx);
    const planned = planWithOption(ctx, item, missing, option, depth, nextStack);
    if (planned.ok) {
      if (depth === 0) setRootNeeds(ctx, option, item, missing);
      return planned;
    }

    restoreContext(ctx, snap);
    if (!bestFailure) {
      bestFailure = planned;
    } else if (bestFailure.code === "dependency_cycle" && planned.code !== "dependency_cycle") {
      bestFailure = planned;
    }
  }

  const resolvedFailure = bestFailure || fail("unsupported_acquisition", `unsupported acquisition for ${item}`, `acquire ${item} manually`);
  if (resolvedFailure.code === "unsupported_acquisition") {
    ctx.log({
      type: "acquisition_unsupported_source",
      goalId: ctx.goalId,
      item,
      reason: resolvedFailure.reason,
      nextNeed: resolvedFailure.nextNeed || null
    });
  }
  ctx.failureMemo.set(key, resolvedFailure);
  return resolvedFailure;
}

function buildGoalPlan(bot, intent, cfg = {}, snapshot = null, log = () => {}) {
  const item = normalizeItemName(intent?.item);
  const count = toCount(intent?.count || cfg.craftDefaultCount || 1, 1);
  const goalId = intent?.goalId || nextGoalId();
  const started = Date.now();
  const maxDepth = toLimit(cfg.dependencyMaxDepth ?? 10, 10);
  const maxNodes = toLimit(cfg.dependencyMaxNodes ?? 1200, 1200);
  const timeoutMs = toCount(cfg.dependencyPlanTimeoutMs ?? 8000, 8000, null);
  const beamWidth = toLimit(cfg.recipePlannerBeamWidth ?? 24, 24);
  const variantCap = toLimit(cfg.recipeVariantCapPerItem ?? 32, 32);

  log({
    type: "planner_budget_start",
    goalId,
    item,
    count,
    timeoutMs,
    maxNodes,
    beamWidth,
    variantCap
  });
  log({ type: "goal_plan_start", goalId, domain: "craft", item, count });

  if (!item) {
    return {
      ok: false,
      goalId,
      domain: "craft",
      code: "unknown_craft_target",
      reason: "unknown craft target",
      nextNeed: "specify a valid item name"
    };
  }

  const recipeDb = buildRecipeDb(bot.version);
  if (!loggedRecipeDbVersions.has(recipeDb.version)) {
    loggedRecipeDbVersions.add(recipeDb.version);
    log({
      type: "recipe_db_loaded",
      version: recipeDb.version,
      outputs: recipeDb.entriesByOutput?.size || 0,
      variants: recipeDb.variantsById?.size || 0
    });
  }
  const mcData = recipeDb.mcData;
  const pseudoPlanningTargets = new Set(["planks", "log"]);
  if (!mcData.itemsByName[item] && !pseudoPlanningTargets.has(item)) {
    return {
      ok: false,
      goalId,
      domain: "craft",
      code: "unknown_craft_target",
      reason: `unknown craft target ${item}`,
      nextNeed: "specify a craftable item"
    };
  }

  const snap = snapshot || buildCapabilitySnapshot(bot, cfg);
  const ctx = {
    bot,
    mcData,
    cfg,
    snapshot: snap,
    goalId,
    maxDepth,
    maxNodes,
    nodeCount: 0,
    startedAt: started,
    timeoutMs,
    beamWidth,
    variantCap,
    budgetExhaustedLogged: false,
    currentItem: null,
    failureMemo: new Map(),
    virtualInventory: cloneInventory(snap.inventory),
    steps: [],
    rootNeeds: [],
    log
  };

  const result = planItem(ctx, item, count, 0);
  const elapsedMs = Date.now() - started;
  const budgetStats = {
    elapsedMs,
    expandedNodes: ctx.nodeCount,
    maxNodes,
    timeoutMs,
    beamWidth,
    variantCap
  };

  if (!result.ok) {
    log({
      type: "goal_plan_fail",
      goalId,
      domain: "craft",
      code: result.code,
      reason: result.reason,
      nextNeed: result.nextNeed || null,
      budgetStats
    });
    return {
      ok: false,
      goalId,
      domain: "craft",
      code: result.code || "goal_plan_fail",
      reason: result.reason || "failed to build plan",
      nextNeed: result.nextNeed || null,
      budgetStats
    };
  }

  const plan = {
    ok: true,
    goalId,
    domain: "craft",
    item,
    count,
    steps: ctx.steps,
    needs: ctx.rootNeeds,
    constraints: {
      timeoutSec: intent?.constraints?.timeoutSec || cfg.autoGatherTimeoutSec || cfg.craftJobTimeoutSec || 90,
      maxDistance: intent?.constraints?.maxDistance || cfg.autoGatherRadius || cfg.maxTaskDistance || 48
    },
    budgetStats
  };
  log({
    type: "goal_plan_built",
    goalId,
    domain: "craft",
    item,
    count,
    stepCount: plan.steps.length,
    needs: plan.needs,
    budgetStats
  });
  return plan;
}

module.exports = {
  buildGoalPlan
};
