const test = require("node:test");
const assert = require("node:assert/strict");

const { validateIntent } = require("../brain/llm_nlu");

test("llm craft target validation rejects unknown items", () => {
  const intent = validateIntent(
    {
      type: "craftItem",
      item: "banana_sword",
      count: 1,
      confidence: 0.99
    },
    "NoSafeSky",
    "1.21.1"
  );
  assert.equal(intent.type, "none");
  assert.equal(intent.reason, "unknown_craft_target");
});

test("llm craft target validation accepts valid minecraft items", () => {
  const intent = validateIntent(
    {
      type: "craftItem",
      item: "stone_sword",
      count: 1,
      confidence: 0.85
    },
    "NoSafeSky",
    "1.21.1"
  );
  assert.equal(intent.type, "craftItem");
  assert.equal(intent.item, "stone_sword");
});
