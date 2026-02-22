const test = require("node:test");
const assert = require("node:assert/strict");

const { parseIntentText, validateIntent } = require("../brain/llm_nlu");

const owner = "NoSafeSky";
const threshold = 0.72;

test("invalid JSON -> none", () => {
  const intent = parseIntentText("{not json", owner);
  assert.equal(intent.type, "none");
  assert.equal(intent.reason, "invalid_json");
});

test("unknown type -> none", () => {
  const intent = validateIntent({ type: "dance", confidence: 0.95 }, owner);
  assert.equal(intent.type, "none");
  assert.equal(intent.reason, "unknown_type");
});

test("missing required args for attackMob -> none", () => {
  const intent = validateIntent({ type: "attackMob", confidence: 0.9 }, owner);
  assert.equal(intent.type, "none");
  assert.equal(intent.reason, "missing_mob");
});

test("low confidence below threshold is rejected", () => {
  const intent = validateIntent({ type: "attackMob", mobType: "pig", confidence: 0.2 }, owner);
  const accepted = intent.type !== "none" && intent.confidence >= threshold ? intent : { type: "none" };
  assert.equal(accepted.type, "none");
});

test("valid craftItem is accepted", () => {
  const intent = validateIntent({ type: "craftItem", item: "wooden_sword", count: 1, confidence: 0.9 }, owner);
  assert.equal(intent.type, "craftItem");
  assert.equal(intent.item, "wooden_sword");
  assert.equal(intent.count, 1);
});
