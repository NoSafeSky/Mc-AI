const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { createCognitiveCore, defaultCognitiveConfig } = require("../brain/cognitive/core");
const { classifyIntentRisk } = require("../brain/cognitive/trust/risk_assessor");
const { MoodEngine } = require("../brain/cognitive/personality/mood_engine");

function makeBot() {
  return {
    health: 20,
    food: 20,
    players: {},
    entities: {},
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 0 } },
    inventory: { items: () => [] },
    time: { isDay: true, timeOfDay: 1000, age: 10 }
  };
}

test("default cognitive config is assistant-first safe", () => {
  const cfg = defaultCognitiveConfig({});
  assert.equal(cfg.cognitiveEnabled, false);
  assert.equal(cfg.cognitive.autonomyPolicy.advisoryOnly, true);
  assert.equal(cfg.cognitive.llmBudget.monologueEnabled, false);
});

test("cognitive wrapExecution preserves deterministic result", async () => {
  const bot = makeBot();
  const advisory = [];
  const logs = [];
  const memoryDir = path.join(os.tmpdir(), `mc-ai-bot-cognitive-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
  fs.mkdirSync(memoryDir, { recursive: true });
  const cognitive = createCognitiveCore(
    bot,
    {
      owner: "NoSafeSky",
      cognitiveEnabled: true,
      cognitive: { enabled: true }
    },
    {
      owner: "NoSafeSky",
      log: (evt) => logs.push(evt),
      sendAdvisory: (msg) => advisory.push(msg),
      isBusy: () => false,
      memoryDir
    }
  );

  const result = await cognitive.wrapExecution(
    { type: "craftItem", item: "stick", count: 1 },
    true,
    async () => ({ status: "success" }),
    { taskId: 1 }
  );

  assert.equal(result.status, "success");
  assert.equal(logs.some((e) => e.type === "cognitive_outcome"), true);
  cognitive.stop();
  fs.rmSync(memoryDir, { recursive: true, force: true });
});

test("risk assessor remains advisory and classifies intent levels", () => {
  assert.equal(classifyIntentRisk({ type: "stopall" }), "trivial");
  assert.equal(classifyIntentRisk({ type: "craftItem" }), "low");
  assert.equal(classifyIntentRisk({ type: "attackMob" }), "medium");
});

test("mood engine exposes deterministic personality modifier", () => {
  const engine = new MoodEngine({
    cognitive: {
      mood: { decayToContentMs: 300000 }
    }
  });
  engine.onTaskOutcome("fail");
  const modifier = engine.personalityModifier();
  assert.equal(typeof modifier, "string");
  assert.equal(modifier.length > 0, true);
});
