const test = require("node:test");
const assert = require("node:assert/strict");

const { buildUnavailableReply } = require("../brain/chat_fallback");
const { llmChatReply } = require("../brain/llm_chat");
const { isRecipeQuestion } = require("../brain/recipe_qa");
const { parseNLU } = require("../brain/nlu");

test("unavailable fallback is dynamic and question-aware", () => {
  const a = buildUnavailableReply("what is minecraft?");
  const b = buildUnavailableReply("where are you?");
  assert.ok(a.includes("what is minecraft?"));
  assert.ok(b.includes("where are you?"));
  assert.notEqual(a, b);
});

test("unavailable fallback handles empty input", () => {
  assert.equal(
    buildUnavailableReply(""),
    "i could not generate a reply right now. try again."
  );
});

test("llm chat call is timeout-capped for isolation", async () => {
  const started = Date.now();
  const reply = await llmChatReply(
    "hi",
    {
      llmProvider: "ollama",
      llmModel: "qwen3:14b",
      llmTimeoutMs: 2000
    },
    [],
    {
      timeoutMs: 1,
      maxTokens: 16
    }
  );
  const elapsed = Date.now() - started;
  assert.equal(reply === null || typeof reply === "string", true);
  assert.ok(elapsed < 1000);
});

test("recipe question stays non-action in deterministic mode", () => {
  const text = "how to craft a mace";
  assert.equal(isRecipeQuestion(text), true);
  const intent = parseNLU(text, { owner: "NoSafeSky" }, null);
  assert.equal(intent.type, "none");
});
