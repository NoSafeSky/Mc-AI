const test = require("node:test");
const assert = require("node:assert/strict");

const { parseJsonFromLlmText, stripThinkTags } = require("../brain/llm_json");

test("stripThinkTags removes think blocks", () => {
  const out = stripThinkTags("<think>reasoning</think>{\"ok\":true}");
  assert.equal(out, "{\"ok\":true}");
});

test("parseJsonFromLlmText parses direct JSON", () => {
  const out = parseJsonFromLlmText("{\"kind\":\"none\"}");
  assert.equal(out.ok, true);
  assert.equal(out.value.kind, "none");
});

test("parseJsonFromLlmText parses JSON wrapped in prose", () => {
  const out = parseJsonFromLlmText("answer: {\"kind\":\"chat\",\"reply\":\"hi\",\"confidence\":0.8}");
  assert.equal(out.ok, true);
  assert.equal(out.value.kind, "chat");
});

test("parseJsonFromLlmText reports invalid_json for non-json text", () => {
  const out = parseJsonFromLlmText("hello world");
  assert.equal(out.ok, false);
  assert.equal(out.reasonCode, "invalid_json");
});
