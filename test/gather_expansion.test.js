const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");

const { executeGoalPlan } = require("../brain/craft_executor");

function makeRunCtx() {
  return {
    id: 301,
    cancelled: false,
    isCancelled() {
      return this.cancelled;
    },
    setStep() {},
    reportProgress() {}
  };
}

test("gather expansion checks rings 24 -> 48 and succeeds on later ring", async () => {
  const seenRadius = [];
  const inv = [];
  const targetPos = new Vec3(10, 64, 10);

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv },
    findBlocks({ matching, maxDistance }) {
      seenRadius.push(maxDistance);
      const sample = { name: "oak_log", position: targetPos };
      if (maxDistance >= 48 && matching(sample)) return [targetPos];
      return [];
    },
    blockAt(pos) {
      if (pos && pos.x === targetPos.x && pos.y === targetPos.y && pos.z === targetPos.z) {
        return { name: "oak_log", position: targetPos, boundingBox: "block" };
      }
      if (pos && pos.y === 63) {
        return { name: "stone", position: new Vec3(pos.x, pos.y, pos.z), boundingBox: "block" };
      }
      return { name: "air", position: pos || new Vec3(0, 0, 0), boundingBox: "empty" };
    },
    dig: async () => {
      inv.push({ name: "oak_log", count: 1 });
    },
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      }
    },
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_gather_expand",
    item: "oak_log",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_gather_expand_s1",
        action: "gather_block",
        args: { item: "oak_log", count: 1, blockNames: ["oak_log"] },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      gatherRadiusSteps: [24, 48, 72],
      gatherExpandRetryPerRing: 1,
      gatherStepTimeoutSec: 1000,
      reasoningEnabled: false
    },
    makeRunCtx(),
    () => {}
  );

  assert.equal(result.status, "success");
  assert.equal(seenRadius.includes(24), true);
  assert.equal(seenRadius.includes(48), true);
});

test("gather expansion returns resource_not_loaded after max ring miss", async () => {
  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    findBlocks: () => [],
    blockAt: () => null,
    pathfinder: { setGoal() {} },
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_gather_miss",
    item: "oak_log",
    count: 1,
    constraints: { timeoutSec: 10 },
    steps: [
      {
        id: "goal_gather_miss_s1",
        action: "gather_block",
        args: { item: "oak_log", count: 1, blockNames: ["oak_log"] },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      gatherRadiusSteps: [24, 48, 72],
      gatherExpandRetryPerRing: 1,
      gatherStepTimeoutSec: 1000,
      missingResourcePolicy: "ask_before_move",
      missingResourceExpandedRadius: 120
    },
    makeRunCtx(),
    () => {}
  );

  assert.equal(result.status, "fail");
  assert.equal(result.code, "resource_not_loaded");
  assert.equal(result.meta.item, "oak_log");
  assert.equal(result.meta.fromRadius, 72);
  assert.equal(result.meta.toRadius, 120);
  assert.match(result.reason, /within 72/i);
});

test("critical progression resource keeps auto-relocate boundary instead of asking", async () => {
  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    findBlocks: () => [],
    blockAt: () => null,
    pathfinder: { setGoal() {} },
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_gather_miss_iron",
    item: "raw_iron",
    count: 1,
    constraints: { timeoutSec: 10 },
    steps: [
      {
        id: "goal_gather_miss_iron_s1",
        action: "gather_block",
        args: { item: "raw_iron", count: 1, blockNames: ["iron_ore", "deepslate_iron_ore"] },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      gatherRadiusSteps: [24, 48, 72],
      gatherExpandRetryPerRing: 1,
      gatherStepTimeoutSec: 1000,
      missingResourcePolicy: "auto_relocate",
      missingResourceExpandedRadius: 192,
      missingResourceMaxRelocations: 0
    },
    makeRunCtx(),
    () => {}
  );

  assert.equal(result.status, "fail");
  assert.equal(result.code, "resource_not_loaded");
  assert.equal(result.meta.item, "raw_iron");
});

test("gather uses local block scan when findBlocks misses nearby block", async () => {
  const inv = [];
  const targetPos = new Vec3(1, 64, 0);
  let findBlocksCalls = 0;

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv },
    findBlocks() {
      findBlocksCalls += 1;
      return [];
    },
    blockAt(pos) {
      if (!pos) return null;
      const p = new Vec3(pos.x, pos.y, pos.z);
      if (p.x === targetPos.x && p.y === targetPos.y && p.z === targetPos.z) {
        return { name: "oak_log", position: p, boundingBox: "block" };
      }
      if (p.y === 63) {
        return { name: "dirt", position: p, boundingBox: "block" };
      }
      return { name: "air", position: p, boundingBox: "empty" };
    },
    dig: async () => {
      inv.push({ name: "oak_log", count: 1 });
    },
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      }
    },
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_local_scan",
    item: "oak_log",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_local_scan_s1",
        action: "gather_block",
        args: { item: "oak_log", count: 1, blockNames: ["oak_log"] },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      gatherRadiusSteps: [24],
      gatherExpandRetryPerRing: 1,
      gatherStepTimeoutSec: 1000,
      reasoningEnabled: false
    },
    makeRunCtx(),
    () => {}
  );

  assert.equal(findBlocksCalls > 0, true);
  assert.equal(result.status, "success");
});

test("gather cobblestone mines shallow stone from stand spot one block above", async () => {
  const inv = [];
  const targetPos = new Vec3(5, 63, 0);
  let broken = false;

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv },
    findBlocks({ matching }) {
      const sample = { name: "stone", position: targetPos };
      return matching(sample) ? [targetPos] : [];
    },
    blockAt(pos) {
      if (!pos) return null;
      const p = new Vec3(pos.x, pos.y, pos.z);
      if (p.x === targetPos.x && p.y === targetPos.y && p.z === targetPos.z) {
        return broken
          ? { name: "air", position: p, boundingBox: "empty" }
          : { name: "stone", position: p, boundingBox: "block" };
      }
      if (p.y === 63) {
        return { name: "dirt", position: p, boundingBox: "block" };
      }
      if (p.y === 62) {
        return { name: "stone", position: p, boundingBox: "block" };
      }
      return { name: "air", position: p, boundingBox: "empty" };
    },
    dig: async () => {
      broken = true;
      inv.push({ name: "cobblestone", count: 1 });
    },
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      }
    },
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_shallow_stone",
    item: "cobblestone",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_shallow_stone_s1",
        action: "gather_block",
        args: { item: "cobblestone", count: 1, blockNames: ["stone"], preferredBlocks: ["stone"] },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      gatherRadiusSteps: [24],
      gatherExpandRetryPerRing: 1,
      gatherStepTimeoutSec: 1000,
      strictHarvestToolGate: false,
      reasoningEnabled: false
    },
    makeRunCtx(),
    () => {}
  );

  assert.equal(result.status, "success");
});

test("cobblestone missing-source reason references stone source", async () => {
  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    findBlocks: () => [],
    blockAt: () => null,
    pathfinder: { setGoal() {} },
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_cobble_reason",
    item: "cobblestone",
    count: 1,
    constraints: { timeoutSec: 10 },
    steps: [
      {
        id: "goal_cobble_reason_s1",
        action: "gather_block",
        args: { item: "cobblestone", count: 1, blockNames: ["stone", "cobblestone"] },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      gatherRadiusSteps: [24],
      gatherExpandRetryPerRing: 1,
      gatherStepTimeoutSec: 1000,
      missingResourcePolicy: "ask_before_move",
      missingResourceExpandedRadius: 120
    },
    makeRunCtx(),
    () => {}
  );

  assert.equal(result.status, "fail");
  assert.equal(result.code, "resource_not_loaded");
  assert.match(result.reason, /stone\/cobblestone/i);
});

test("gather blocks recently failed target and avoids immediate reselection", async () => {
  const events = [];
  const targetPos = new Vec3(2, 64, 0);
  let selectedCount = 0;

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    findBlocks({ matching }) {
      const sample = { name: "stone", position: targetPos };
      return matching(sample) ? [targetPos] : [];
    },
    blockAt(pos) {
      if (!pos) return null;
      const p = new Vec3(pos.x, pos.y, pos.z);
      if (p.x === targetPos.x && p.y === targetPos.y && p.z === targetPos.z) {
        return { name: "stone", position: p, boundingBox: "block" };
      }
      if (p.y === 63) {
        return { name: "dirt", position: p, boundingBox: "block" };
      }
      return { name: "air", position: p, boundingBox: "empty" };
    },
    dig: async () => {},
    pathfinder: { setGoal() {} },
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_recent_fail",
    item: "cobblestone",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_recent_fail_s1",
        action: "gather_block",
        args: { item: "cobblestone", count: 1, blockNames: ["stone"], preferredBlocks: ["stone"] },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      gatherRadiusSteps: [24],
      gatherExpandRetryPerRing: 3,
      gatherTargetFailLimit: 2,
      gatherCandidateBanMs: 30000,
      strictHarvestToolGate: false,
      reasoningEnabled: false
    },
    makeRunCtx(),
    (evt) => {
      events.push(evt);
      if (evt.type === "gather_target_selected") selectedCount += 1;
    }
  );

  assert.equal(result.status, "fail");
  assert.equal(result.code, "path_blocked");
  assert.equal(selectedCount, 2);
  assert.equal(events.some((e) => e.type === "gather_candidate_skip_recent_fail"), true);
});

test("log gather rejects unsafe stand positions and fails explicitly", async () => {
  const events = [];
  const targetPos = new Vec3(2, 64, 0);

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    findBlocks({ matching }) {
      const sample = { name: "oak_log", position: targetPos };
      return matching(sample) ? [targetPos] : [];
    },
    blockAt(pos) {
      if (!pos) return null;
      const p = new Vec3(pos.x, pos.y, pos.z);
      if (p.x === targetPos.x && p.y === targetPos.y && p.z === targetPos.z) {
        return { name: "oak_log", position: p, boundingBox: "block" };
      }
      if (p.y === 63) {
        return { name: "oak_leaves", position: p, boundingBox: "block" };
      }
      return { name: "air", position: p, boundingBox: "empty" };
    },
    pathfinder: { setGoal() {} },
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_log_unsafe_stand",
    item: "log",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_log_unsafe_stand_s1",
        action: "gather_block",
        args: { item: "log", count: 1, blockNames: ["oak_log"], preferredBlocks: ["oak_log"] },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      gatherRadiusSteps: [24],
      gatherExpandRetryPerRing: 1,
      strictHarvestToolGate: false,
      reasoningEnabled: false
    },
    makeRunCtx(),
    (evt) => events.push(evt)
  );

  assert.equal(result.status, "fail");
  assert.equal(result.code, "path_blocked");
  assert.equal(events.some((e) => e.type === "gather_target_skip_unsafe"), true);
  assert.equal(events.some((e) => e.type === "gather_target_selected"), false);
});

test("log gather follows up same tree with treeId context", async () => {
  const events = [];
  const inv = [];
  const broken = new Set();
  const logA = new Vec3(2, 64, 0);
  const logB = new Vec3(2, 65, 0);
  const otherTree = new Vec3(5, 64, 0);

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv },
    findBlocks({ matching }) {
      const out = [];
      for (const pos of [logA, logB, otherTree]) {
        const sample = { name: "oak_log", position: pos };
        if (matching(sample) && !broken.has(`${pos.x}|${pos.y}|${pos.z}`)) out.push(pos);
      }
      return out;
    },
    blockAt(pos) {
      if (!pos) return null;
      const p = new Vec3(pos.x, pos.y, pos.z);
      const key = `${p.x}|${p.y}|${p.z}`;
      if ((key === `${logA.x}|${logA.y}|${logA.z}` || key === `${logB.x}|${logB.y}|${logB.z}` || key === `${otherTree.x}|${otherTree.y}|${otherTree.z}`) && !broken.has(key)) {
        return { name: "oak_log", position: p, boundingBox: "block" };
      }
      if (p.y === 63) {
        return { name: "dirt", position: p, boundingBox: "block" };
      }
      return { name: "air", position: p, boundingBox: "empty" };
    },
    dig: async (block) => {
      broken.add(`${block.position.x}|${block.position.y}|${block.position.z}`);
      inv.push({ name: "oak_log", count: 1 });
    },
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      }
    },
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_same_tree_followup",
    item: "log",
    count: 2,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_same_tree_followup_s1",
        action: "gather_block",
        args: { item: "log", count: 2, blockNames: ["oak_log"], preferredBlocks: ["oak_log"] },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      gatherRadiusSteps: [24],
      gatherExpandRetryPerRing: 1,
      gatherLogSameTreeFollowups: 2,
      strictHarvestToolGate: false,
      reasoningEnabled: false
    },
    makeRunCtx(),
    (evt) => events.push(evt)
  );

  const selected = events.filter((e) => e.type === "gather_target_selected");
  assert.equal(result.status, "success");
  assert.equal(selected.length >= 2, true);
  assert.equal(typeof selected[0].treeId, "string");
  assert.equal(selected[0].treeId, selected[1].treeId);
});

test("log tree ban stops repeated unproductive reselection", async () => {
  const events = [];
  const logA = new Vec3(2, 64, 0);
  const logB = new Vec3(2, 65, 0);
  let selectedCount = 0;

  const bot = {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    findBlocks({ matching }) {
      const out = [];
      for (const pos of [logA, logB]) {
        const sample = { name: "oak_log", position: pos };
        if (matching(sample)) out.push(pos);
      }
      return out;
    },
    blockAt(pos) {
      if (!pos) return null;
      const p = new Vec3(pos.x, pos.y, pos.z);
      if (
        (p.x === logA.x && p.y === logA.y && p.z === logA.z)
        || (p.x === logB.x && p.y === logB.y && p.z === logB.z)
      ) {
        return { name: "oak_log", position: p, boundingBox: "block" };
      }
      if (p.y === 63) {
        return { name: "dirt", position: p, boundingBox: "block" };
      }
      return { name: "air", position: p, boundingBox: "empty" };
    },
    dig: async () => {},
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      }
    },
    waitForTicks: async () => {}
  };

  const goalPlan = {
    ok: true,
    goalId: "goal_log_tree_ban",
    item: "log",
    count: 1,
    constraints: { timeoutSec: 20 },
    steps: [
      {
        id: "goal_log_tree_ban_s1",
        action: "gather_block",
        args: { item: "log", count: 1, blockNames: ["oak_log"], preferredBlocks: ["oak_log"] },
        retryPolicy: {},
        timeoutMs: 1000
      }
    ]
  };

  const result = await executeGoalPlan(
    bot,
    goalPlan,
    {
      gatherRadiusSteps: [24],
      gatherExpandRetryPerRing: 4,
      gatherTargetFailLimit: 2,
      gatherTreeFailLimit: 2,
      gatherLogCandidateBanMs: 60000,
      strictHarvestToolGate: false,
      reasoningEnabled: false
    },
    makeRunCtx(),
    (evt) => {
      events.push(evt);
      if (evt.type === "gather_target_selected") selectedCount += 1;
    }
  );

  assert.equal(result.status, "fail");
  assert.equal(result.code, "path_blocked");
  assert.equal(selectedCount, 2);
});
