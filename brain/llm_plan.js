const fetch = require("node-fetch");
const { buildOllamaGenerateBody, extractOllamaText } = require("./llm_ollama");

const ALLOWED_ACTIONS = new Set([
  "explore",
  "seekVillage",
  "harvestWood",
  "craftBasic",
  "attackHostile",
  "huntFood",
  "attackMob",
  "followOwner",
  "comeOwner",
  "wait"
]);

let lastPlanFailure = null;

function sanitizePlan(plan, cfg) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.steps)) return null;
  const maxRadius = cfg.maxExploreRadius || 500;
  const steps = plan.steps
    .map((s) => ({
      action: s.action,
      mobType: typeof s.mobType === "string" ? s.mobType.toLowerCase() : undefined,
      radius: Math.min(maxRadius, Math.max(32, s.radius || maxRadius)),
      seconds: Math.min(300, Math.max(5, s.seconds || 30))
    }))
    .filter((s) => ALLOWED_ACTIONS.has(s.action));
  if (!steps.length) return null;
  return { steps };
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

function parseOllamaPlanPayload(data, cfg) {
  const extracted = extractOllamaText(data);
  if (!extracted.ok) {
    lastPlanFailure = {
      reason: extracted.code,
      provider: "ollama",
      hasThinking: extracted.hasThinking
    };
    return null;
  }

  try {
    const parsed = JSON.parse(extracted.text);
    const safe = sanitizePlan(parsed, cfg);
    if (!safe) {
      lastPlanFailure = { reason: "invalid_plan_shape", provider: "ollama" };
      return null;
    }
    return safe;
  } catch (e) {
    lastPlanFailure = { reason: "invalid_json", provider: "ollama", error: String(e) };
    return null;
  }
}

async function llmPlan(message, cfg, state) {
  const provider = (cfg.llmProvider || "groq").toLowerCase();
  const model = cfg.llmModel || "llama-3.3-70b-versatile";
  const maxRadius = cfg.maxExploreRadius || 500;
  lastPlanFailure = null;

  const system = `You are a planner for a Minecraft bot. Return ONLY valid JSON.
Allowed actions: explore, seekVillage, harvestWood, craftBasic, attackHostile, huntFood, attackMob, followOwner, comeOwner, wait.
Use small number of steps (1-4). No extra text.
If the message is not actionable or unsafe, return {"steps":[]}.`;

  const prompt = `owner=${cfg.owner}
maxRadius=${maxRadius}
message="${message}"
Return JSON like: {"steps":[{"action":"explore","radius":300,"seconds":60}]}
For "kill a pig" use: {"steps":[{"action":"attackMob","mobType":"pig","seconds":60}]}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.llmTimeoutMs || 3000);

  try {
    if (provider === "groq") {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) {
        lastPlanFailure = { reason: "llm_unavailable", provider };
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
          temperature: 0.2
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        lastPlanFailure = { reason: "llm_http_error", provider, status: res.status };
        return null;
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim() || "";
      const parsed = JSON.parse(text);
      return sanitizePlan(parsed, cfg);
    }

    if (provider === "gemini") {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        lastPlanFailure = { reason: "llm_unavailable", provider };
        return null;
      }
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const body = {
        contents: [{ role: "user", parts: [{ text: `${system}\n\n${prompt}` }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
      };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) {
        lastPlanFailure = { reason: "llm_http_error", provider, status: res.status };
        return null;
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
      const parsed = JSON.parse(text);
      return sanitizePlan(parsed, cfg);
    }

    const mode = (cfg.ollamaRequestMode || "stable").toLowerCase();
    const disableThinking = mode === "stable" ? cfg.ollamaDisableThinking !== false : false;
    const body = buildOllamaGenerateBody({
      model,
      system,
      prompt,
      temperature: 0.2,
      disableThinking
    });

    const res = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      lastPlanFailure = { reason: "llm_http_error", provider, status: res.status };
      return null;
    }
    const data = await res.json();
    return parseOllamaPlanPayload(data, cfg);
  } catch (e) {
    lastPlanFailure = {
      reason: classifyLlmError(provider, e),
      provider,
      error: String(e)
    };
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function getLastPlanFailure() {
  return lastPlanFailure;
}

module.exports = { llmPlan, getLastPlanFailure, parseOllamaPlanPayload };
