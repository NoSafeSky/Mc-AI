const test = require("node:test");
const assert = require("node:assert/strict");

const { parseOllamaChatPayload, getLastChatFailure } = require("../brain/llm_chat");

test("chat payload returns model text when response is present", () => {
  const text = parseOllamaChatPayload({
    response: "minecraft is a sandbox game."
  });
  assert.equal(text, "minecraft is a sandbox game.");
  assert.equal(getLastChatFailure(), null);
});

test("chat payload returns null for thinking-only response", () => {
  const text = parseOllamaChatPayload({
    response: "",
    thinking: "internal thought"
  });
  const failure = getLastChatFailure();
  assert.equal(text, null);
  assert.equal(failure?.reason, "llm_thinking_only_response");
  assert.equal(failure?.hasThinking, true);
});
