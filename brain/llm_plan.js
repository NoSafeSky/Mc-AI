const fetch = require("node-fetch");
const { buildOllamaGenerateBody, extractOllamaText } = require("./llm_ollama");
const { parseRouteText } = require("./llm_goal_schema");

let lastPlanFailure = null;

function setLastPlanFailure(failure) {
  lastPlanFailure = failure || null;
}

function classifyLlmError(provider, error) {
  if (error?.name === "AbortError") return "llm_timeout";
  const text = String(error || "");
  if (
    provider === "ollama" &&
    /(ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|EAI_AGAIN)/i.test(text)
  ) {
    return "llm_provider_unreachable";
  }
  return "llm_error";
}

function routeValidationOptions(cfg, context = {}) {
  return {
    owner: context.owner || cfg.owner || "",
    maxGoals: cfg.llmPlanMaxGoals || 5,
    maxExploreRadius: cfg.maxExploreRadius || 500,
    defaultCraftCount: cfg.craftDefaultCount || 1,
    version: cfg.version || "1.21.1"
  };
}

function parseRoutePayloadText(text, cfg, context = {}) {
  const parsed = parseRouteText(text, routeValidationOptions(cfg, context));
  if (!parsed.ok) {
    setLastPlanFailure({
      reason: parsed.reasonCode || "invalid_route",
      provider: context.provider || (cfg.llmProvider || "unknown").toLowerCase(),
      error: parsed.reason || null
    });
    return null;
  }

  setLastPlanFailure(null);
  return parsed.value;
}

function parseOllamaPlanPayload(data, cfg, context = {}) {
  const extracted = extractOllamaText(data);
  if (!extracted.ok) {
    setLastPlanFailure({
      reason: extracted.code,
      provider: "ollama",
      hasThinking: extracted.hasThinking
    });
    return null;
  }

  return parseRoutePayloadText(extracted.text, cfg, {
    ...context,
    provider: "ollama"
  });
}

function buildSystemPrompt({ allowAction, allowChat, owner }) {
  const actionLine = allowAction
    ? "You may return kind=action with goals[]."
    : "Do not return kind=action.";
  const chatLine = allowChat
    ? "You may return kind=chat with reply."
    : "Do not return kind=chat.";

  return [
    "You are a Minecraft bot router.",
    "Return ONLY one valid JSON object. No markdown. No extra text.",
    actionLine,
    chatLine,
    "Allowed kinds: action, chat, reject, none.",
    "For action use goals with this GoalSpec schema:",
    '{"type":"craftItem|attackMob|attackHostile|huntFood|follow|come|explore|harvest|stop|stopall|resume|craftBasic|missionStart|missionStatus|missionSuggest|missionAccept|missionReject|missionPause|missionResume|missionAbort|queueStatus|queueClear|giveItem|stashNow|regroup","args":{},"priority":0}',
    "Never output mineflayer API calls or raw code.",
    `Default owner target is: ${owner || "owner"}.`
  ].join("\n");
}

function buildUserPrompt(message, cfg, context = {}) {
  const maxGoals = cfg.llmPlanMaxGoals || 5;
  const maxRadius = cfg.maxExploreRadius || 500;
  const isOwner = context.isOwner !== false;
  return [
    `isOwner=${isOwner}`,
    `owner=${context.owner || cfg.owner || ""}`,
    `maxGoals=${maxGoals}`,
    `maxExploreRadius=${maxRadius}`,
    `message="${String(message || "").replace(/"/g, "\\\"")}"`,
    "Examples:",
    '{"kind":"action","confidence":0.92,"goals":[{"type":"craftItem","args":{"item":"wooden_sword","count":1}}]}',
    '{"kind":"action","confidence":0.9,"goals":[{"type":"attackMob","args":{"mobType":"pig"}}]}',
    '{"kind":"action","confidence":0.9,"goals":[{"type":"missionStart","args":{}}]}',
    '{"kind":"action","confidence":0.87,"goals":[{"type":"missionStatus","args":{}}]}',
    '{"kind":"action","confidence":0.86,"goals":[{"type":"missionSuggest","args":{}}]}',
    '{"kind":"chat","confidence":0.88,"reply":"Minecraft is a sandbox game where you gather resources and build things."}',
    '{"kind":"reject","confidence":0.92,"reasonCode":"unsafe_request"}',
    '{"kind":"none","confidence":0.1}'
  ].join("\n");
}

async function llmPlanRoute(message, cfg, state, context = {}) {
  const provider = (cfg.llmProvider || "ollama").toLowerCase();
  const model = cfg.llmModel || "qwen3:14b";
  const allowAction = context.allowAction !== false;
  const allowChat = context.allowChat !== false;

  const system = buildSystemPrompt({
    allowAction,
    allowChat,
    owner: context.owner || cfg.owner
  });
  const prompt = buildUserPrompt(message, cfg, context);

  const timeoutMs = Number(cfg.llmPlanTimeoutMs || cfg.llmTimeoutMs || 8000);
  const controller = new AbortController();
  const timeout = cfg?.disableTimeouts === true ? null : setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (provider === "groq") {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) {
        setLastPlanFailure({ reason: "llm_unavailable", provider });
        return null;
      }
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt }
          ],
          temperature: 0.1
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        setLastPlanFailure({ reason: "llm_http_error", provider, status: res.status });
        return null;
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim() || "";
      return parseRoutePayloadText(text, cfg, { ...context, provider });
    }

    if (provider === "gemini") {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        setLastPlanFailure({ reason: "llm_unavailable", provider });
        return null;
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `${system}\n\n${prompt}` }] }],
          generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        setLastPlanFailure({ reason: "llm_http_error", provider, status: res.status });
        return null;
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
      return parseRoutePayloadText(text, cfg, { ...context, provider });
    }

    const mode = (cfg.ollamaRequestMode || "stable").toLowerCase();
    const disableThinking = mode === "stable" ? cfg.ollamaDisableThinking !== false : false;
    const body = buildOllamaGenerateBody({
      model,
      system,
      prompt,
      temperature: 0.1,
      disableThinking
    });

    const res = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      setLastPlanFailure({ reason: "llm_http_error", provider, status: res.status });
      return null;
    }

    const data = await res.json();
    return parseOllamaPlanPayload(data, cfg, context);
  } catch (error) {
    setLastPlanFailure({
      reason: classifyLlmError(provider, error),
      provider,
      error: String(error)
    });
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function goalToLegacyStep(goal, cfg) {
  if (!goal || typeof goal !== "object") return null;
  const type = goal.type;
  const args = goal.args || {};

  if (type === "follow") return { action: "followOwner" };
  if (type === "come") return { action: "comeOwner" };
  if (type === "harvest") return { action: "harvestWood" };
  if (type === "craftBasic") return { action: "craftBasic" };
  if (type === "craftItem") return { action: "craftBasic" };
  if (type === "attackMob") return { action: "attackMob", mobType: args.mobType || "pig" };
  if (type === "attackHostile") return { action: "attackHostile" };
  if (type === "huntFood") return { action: "huntFood" };
  if (type === "explore") {
    return {
      action: "explore",
      radius: clamp(args.radius, 32, cfg.maxExploreRadius || 500, 128),
      seconds: clamp(args.seconds, 5, 300, 45)
    };
  }
  if (type === "stop" || type === "stopall" || type === "resume") {
    return { action: "wait", seconds: 1 };
  }
  if (
    type === "missionStart"
    || type === "missionStatus"
    || type === "missionSuggest"
    || type === "missionAccept"
    || type === "missionReject"
    || type === "missionPause"
    || type === "missionResume"
    || type === "missionAbort"
    || type === "queueStatus"
    || type === "queueClear"
    || type === "giveItem"
    || type === "stashNow"
    || type === "regroup"
    || type === "startObjectiveRun"
    || type === "runStatus"
    || type === "runPause"
    || type === "runResume"
    || type === "runAbort"
    || type === "runNext"
  ) {
    return { action: "wait", seconds: 1 };
  }

  return null;
}

async function llmPlan(message, cfg, state) {
  const route = await llmPlanRoute(message, cfg, state, {
    owner: cfg.owner,
    isOwner: true,
    allowAction: true,
    allowChat: false
  });

  if (!route) return null;
  if (route.kind !== "action") {
    setLastPlanFailure({
      reason: route.reasonCode || "non_action_route",
      provider: (cfg.llmProvider || "unknown").toLowerCase()
    });
    return null;
  }

  const steps = (route.goals || [])
    .map((goal) => goalToLegacyStep(goal, cfg))
    .filter(Boolean);

  if (!steps.length) {
    setLastPlanFailure({
      reason: "invalid_plan_shape",
      provider: (cfg.llmProvider || "unknown").toLowerCase()
    });
    return null;
  }

  setLastPlanFailure(null);
  return { steps };
}

function getLastPlanFailure() {
  return lastPlanFailure;
}

module.exports = {
  llmPlan,
  llmPlanRoute,
  getLastPlanFailure,
  parseOllamaPlanPayload
};
