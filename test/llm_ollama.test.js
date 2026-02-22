const test = require("node:test");
const assert = require("node:assert/strict");

const { buildOllamaGenerateBody, extractOllamaText } = require("../brain/llm_ollama");

test("thinking-only + empty response -> llm_thinking_only_response", () => {
  const result = extractOllamaText({
    response: "   ",
    thinking: "reasoning trace here"
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "llm_thinking_only_response");
  assert.equal(result.hasThinking, true);
});

test("normal response text -> success", () => {
  const result = extractOllamaText({
    response: "hello from model"
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "hello from model");
});

test("disableThinking=true adds think:false in request body", () => {
  const body = buildOllamaGenerateBody({
    model: "qwen3:14b",
    system: "sys",
    prompt: "hello",
    disableThinking: true
  });
  assert.equal(body.think, false);
  assert.equal(body.stream, false);
});
