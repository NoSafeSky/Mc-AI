const test = require("node:test");
const assert = require("node:assert/strict");

const { compileGoalSpecsToIntents } = require("../brain/goal_compiler");

test("goal compiler maps valid goals to intents", () => {
  const compiled = compileGoalSpecsToIntents(
    [
      { type: "craftItem", args: { item: "wooden_sword", count: 1 }, confidence: 0.9 },
      { type: "attackMob", args: { mobType: "pig" }, confidence: 0.9 }
    ],
    { version: "1.21.1", entities: {} },
    { owner: "NoSafeSky", craftDefaultCount: 1 },
    { source: "llm", confidence: 0.9 }
  );

  assert.equal(compiled.ok, true);
  assert.equal(compiled.intents.length, 2);
  assert.equal(compiled.intents[0].type, "craftItem");
  assert.equal(compiled.intents[0].item, "wooden_sword");
  assert.equal(compiled.intents[1].type, "attackMob");
  assert.equal(compiled.intents[1].mobType, "pig");
});

test("goal compiler rejects unknown craft items", () => {
  const compiled = compileGoalSpecsToIntents(
    [{ type: "craftItem", args: { item: "banana_sword", count: 1 } }],
    { version: "1.21.1", entities: {} },
    { owner: "NoSafeSky" },
    { source: "llm", confidence: 0.9 }
  );

  assert.equal(compiled.ok, false);
  assert.equal(compiled.reasonCode, "unknown_craft_target");
});

test("goal compiler rejects invalid mob targets", () => {
  const compiled = compileGoalSpecsToIntents(
    [{ type: "attackMob", args: { mobType: "banana" } }],
    { version: "1.21.1", entities: {} },
    { owner: "NoSafeSky" },
    { source: "llm", confidence: 0.9 }
  );

  assert.equal(compiled.ok, false);
  assert.equal(compiled.reasonCode, "unknown_target");
});
