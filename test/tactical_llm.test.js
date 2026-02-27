const test = require("node:test");
const assert = require("node:assert/strict");

const { suggestTacticalHint } = require("../brain/tactical_llm");

test("tactical llm returns null when disabled", async () => {
  const hint = await suggestTacticalHint("phase_tick", { phase: "bootstrap" }, { tacticalLlmEnabled: false }, () => {});
  assert.equal(hint, null);
});

test("tactical llm rejects unsupported provider", async () => {
  const events = [];
  const hint = await suggestTacticalHint(
    "phase_tick",
    { phase: "bootstrap" },
    {
      tacticalLlmEnabled: true,
      tacticalLlmProvider: "unsupported",
      tacticalLlmMaxCallsPerMin: 5
    },
    (e) => events.push(e)
  );
  assert.equal(hint, null);
  assert.equal(events.some((e) => e.type === "tactical_llm_hint_reject"), true);
});
