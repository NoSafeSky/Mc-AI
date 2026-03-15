const test = require("node:test");
const assert = require("node:assert/strict");

const { parseNLU } = require("../brain/nlu");

const cfg = { owner: "NoSafeSky", maxExploreRadius: 500 };

test("parse kill a pig", () => {
  const intent = parseNLU("kill a pig", cfg, null);
  assert.equal(intent.type, "attackMob");
  assert.equal(intent.mobType, "pig");
  assert.equal(intent.source, "rules");
});

test("parse attack zombie", () => {
  const intent = parseNLU("attack zombie", cfg, null);
  assert.equal(intent.type, "attackMob");
  assert.equal(intent.mobType, "zombie");
});

test("parse kill piggy alias", () => {
  const intent = parseNLU("kill piggy", cfg, null);
  assert.equal(intent.type, "attackMob");
  assert.equal(intent.mobType, "pig");
});

test("parse kill two pigs captures attack count", () => {
  const intent = parseNLU("kill two pigs", cfg, null);
  assert.equal(intent.type, "attackMob");
  assert.equal(intent.mobType, "pig");
  assert.equal(intent.count, 2);
});

test("parse follow me", () => {
  const intent = parseNLU("follow me", cfg, null);
  assert.equal(intent.type, "follow");
  assert.equal(intent.target, "NoSafeSky");
});

test("parse stop everything", () => {
  const intent = parseNLU("stop everything", cfg, null);
  assert.equal(intent.type, "stopall");
});

test("parse stopall", () => {
  const intent = parseNLU("stopall", cfg, null);
  assert.equal(intent.type, "stopall");
});

test("parse drop all items", () => {
  const intent = parseNLU("drop all items", cfg, null);
  assert.equal(intent.type, "dropAllItems");
});

test("parse dropall", () => {
  const intent = parseNLU("dropall", cfg, null);
  assert.equal(intent.type, "dropAllItems");
});

test("parse drop all", () => {
  const intent = parseNLU("drop all", cfg, null);
  assert.equal(intent.type, "dropAllItems");
});

test("parse drop inventory", () => {
  const intent = parseNLU("drop inventory", cfg, null);
  assert.equal(intent.type, "dropAllItems");
});

test("parse hello bot", () => {
  const intent = parseNLU("hello bot", cfg, null);
  assert.equal(intent.type, "none");
});

test("recipe question is non-action intent", () => {
  const intent = parseNLU("how to craft a mace", cfg, null);
  assert.equal(intent.type, "none");
  assert.equal(intent.reason, "recipe_question");
});

test("parse give me a wooden pickaxe", () => {
  const intent = parseNLU("give me a wooden pickaxe", cfg, null);
  assert.equal(intent.type, "giveItem");
  assert.equal(intent.item, "wooden_pickaxe");
  assert.equal(intent.count, 1);
});

test("parse give me unknown item returns missing_item", () => {
  const intent = parseNLU("give me banana sword", cfg, null);
  assert.equal(intent.type, "none");
  assert.equal(intent.reason, "missing_item");
});
