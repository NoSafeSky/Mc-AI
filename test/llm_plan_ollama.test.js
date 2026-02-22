const test = require("node:test");
const assert = require("node:assert/strict");

const { parseOllamaPlanPayload, getLastPlanFailure } = require("../brain/llm_plan");

test("ollama plan payload sets lastPlanFailure on thinking-only response", () => {
  const plan = parseOllamaPlanPayload(
    { response: "", thinking: "internal reasoning" },
    { maxExploreRadius: 500 }
  );
  const failure = getLastPlanFailure();
  assert.equal(plan, null);
  assert.equal(failure?.reason, "llm_thinking_only_response");
  assert.equal(failure?.provider, "ollama");
});

test("ollama plan payload parses valid JSON steps", () => {
  const plan = parseOllamaPlanPayload(
    {
      response: "{\"steps\":[{\"action\":\"explore\",\"radius\":120,\"seconds\":30}]}"
    },
    { maxExploreRadius: 500 }
  );
  assert.ok(plan);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].action, "explore");
});
