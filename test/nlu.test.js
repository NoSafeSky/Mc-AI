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

test("parse follow me", () => {
  const intent = parseNLU("follow me", cfg, null);
  assert.equal(intent.type, "follow");
  assert.equal(intent.target, "NoSafeSky");
});

test("parse stop everything", () => {
  const intent = parseNLU("stop everything", cfg, null);
  assert.equal(intent.type, "stopall");
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
