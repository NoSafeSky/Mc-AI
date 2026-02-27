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

test("goal compiler maps mission control and give item goals", () => {
  const compiled = compileGoalSpecsToIntents(
    [
      { type: "missionStart", args: {} },
      { type: "giveItem", args: { item: "cobblestone", count: 8 } }
    ],
    { version: "1.21.1", entities: {} },
    { owner: "NoSafeSky" },
    { source: "llm", confidence: 0.9 }
  );
  assert.equal(compiled.ok, true);
  assert.equal(compiled.intents[0].type, "missionStart");
  assert.equal(compiled.intents[1].type, "giveItem");
  assert.equal(compiled.intents[1].item, "cobblestone");
  assert.equal(compiled.intents[1].count, 8);
});

test("goal compiler normalizes deprecated run aliases to mission intents", () => {
  const compiled = compileGoalSpecsToIntents(
    [
      { type: "startObjectiveRun", args: {} },
      { type: "runStatus", args: {} },
      { type: "runAbort", args: {} }
    ],
    { version: "1.21.1", entities: {} },
    { owner: "NoSafeSky" },
    { source: "llm", confidence: 0.9 }
  );
  assert.equal(compiled.ok, true);
  assert.equal(compiled.intents[0].type, "missionStart");
  assert.equal(compiled.intents[1].type, "missionStatus");
  assert.equal(compiled.intents[2].type, "missionAbort");
});

test("goal compiler rewrites craftItem to giveItem for give phrase command text", () => {
  const compiled = compileGoalSpecsToIntents(
    [{ type: "craftItem", args: { item: "wooden_pickaxe", count: 1 } }],
    { version: "1.21.1", entities: {} },
    { owner: "NoSafeSky" },
    { source: "llm", confidence: 0.9, commandText: "give me a wooden pickaxe" }
  );
  assert.equal(compiled.ok, true);
  assert.equal(compiled.intents[0].type, "giveItem");
  assert.equal(compiled.intents[0].item, "wooden_pickaxe");
  assert.equal(compiled.intents[0].count, 1);
});

test("goal compiler give phrase with missing item returns missing_item", () => {
  const compiled = compileGoalSpecsToIntents(
    [{ type: "craftItem", args: { item: "wooden_pickaxe", count: 1 } }],
    { version: "1.21.1", entities: {} },
    { owner: "NoSafeSky" },
    { source: "llm", confidence: 0.9, commandText: "give me banana blade" }
  );
  assert.equal(compiled.ok, false);
  assert.equal(compiled.reasonCode, "missing_item");
});
