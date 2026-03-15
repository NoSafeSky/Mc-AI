const test = require("node:test");
const assert = require("node:assert/strict");

const { routePromptWithLLM } = require("../brain/llm_router");

test("owner prompt routes to action goals", async () => {
  const route = await routePromptWithLLM(
    "craft me a wooden sword",
    {
      owner: "NoSafeSky",
      llmActionMinConfidence: 0.7,
      llmChatMinConfidence: 0.55,
      llmRouteNonOwnerChat: true
    },
    {},
    {
      isOwner: true,
      owner: "NoSafeSky",
      history: [],
      planFn: async () => ({
        kind: "action",
        confidence: 0.92,
        goals: [{ type: "craftItem", args: { item: "wooden_sword", count: 1 } }]
      })
    }
  );

  assert.equal(route.kind, "action");
  assert.equal(route.goals.length, 1);
  assert.equal(route.goals[0].type, "craftItem");
});

test("owner chat route uses planner-provided reply", async () => {
  const route = await routePromptWithLLM(
    "what is minecraft",
    {
      owner: "NoSafeSky",
      llmActionMinConfidence: 0.7,
      llmChatMinConfidence: 0.55,
      llmRouteNonOwnerChat: true
    },
    {},
    {
      isOwner: true,
      owner: "NoSafeSky",
      history: [],
      planFn: async () => ({ kind: "chat", confidence: 0.9, reply: "placeholder" })
    }
  );

  assert.equal(route.kind, "chat");
  assert.equal(route.reply, "placeholder");
});

test("low-confidence owner action returns none", async () => {
  const route = await routePromptWithLLM(
    "maybe do something",
    {
      owner: "NoSafeSky",
      llmActionMinConfidence: 0.7,
      llmChatMinConfidence: 0.55,
      llmRouteNonOwnerChat: true
    },
    {},
    {
      isOwner: true,
      owner: "NoSafeSky",
      history: [],
      planFn: async () => ({ kind: "action", confidence: 0.2, goals: [{ type: "follow", args: {} }] })
    }
  );

  assert.equal(route.kind, "none");
  assert.equal(route.reasonCode, "low_action_confidence");
});

test("non-owner prompt stays chat-only", async () => {
  const route = await routePromptWithLLM(
    "craft me a sword",
    {
      owner: "NoSafeSky",
      llmRouteNonOwnerChat: true
    },
    {},
    {
      isOwner: false,
      owner: "NoSafeSky",
      history: [],
      chatFn: async () => "I can chat, but only owner can command me."
    }
  );

  assert.equal(route.kind, "chat");
  assert.match(route.reply, /only owner/i);
});

test("non-owner chat passes personality modifier to chat fn", async () => {
  let seenModifier = null;
  const route = await routePromptWithLLM(
    "hello",
    {
      owner: "NoSafeSky",
      llmRouteNonOwnerChat: true
    },
    {},
    {
      isOwner: false,
      owner: "NoSafeSky",
      history: [],
      personalityModifier: "Tone: concise and cautious.",
      chatFn: async (_message, _cfg, _history, opts) => {
        seenModifier = opts?.personalityModifier || null;
        return "hi";
      }
    }
  );

  assert.equal(route.kind, "chat");
  assert.equal(seenModifier, "Tone: concise and cautious.");
});
