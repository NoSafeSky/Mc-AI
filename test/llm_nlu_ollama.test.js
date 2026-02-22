const test = require("node:test");
const assert = require("node:assert/strict");

const { parseOllamaIntentPayload } = require("../brain/llm_nlu");

test("ollama intent payload returns none + unavailable for empty response", () => {
  const intent = parseOllamaIntentPayload({ response: "" }, "NoSafeSky");
  assert.equal(intent.type, "none");
  assert.equal(intent.unavailable, true);
  assert.equal(intent.reason, "llm_empty_response");
});

test("ollama intent payload returns none + unavailable for thinking-only response", () => {
  const intent = parseOllamaIntentPayload(
    { response: "", thinking: "thoughts" },
    "NoSafeSky"
  );
  assert.equal(intent.type, "none");
  assert.equal(intent.unavailable, true);
  assert.equal(intent.reason, "llm_thinking_only_response");
});
