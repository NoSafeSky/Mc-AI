const fetch = require("node-fetch");
const { buildOllamaGenerateBody, extractOllamaText } = require("./llm_ollama");
const { parseJsonFromLlmText } = require("./llm_json");

const ALLOWED_TYPES = new Set([
  "follow",
  "come",
  "stop",
  "stopall",
  "resume",
  "setCreepy",
  "stalk",
  "harvest",
  "craftBasic",
  "craftItem",
  "explore",
  "attackMob",
  "attackHostile",
  "huntFood",
  "freeform",
  "none"
]);

function noneIntent(reason = "none", extra = {}) {
  return {
    type: "none",
    source: "llm",
    confidence: 0,
    reason,
    ...extra
  };
}

function isKnownCraftItem(item, version = "1.21.1") {
  const name = String(item || "").toLowerCase().trim();
  if (!name) return false;
  if (name === "planks") return true;
  try {
    const mcData = require("minecraft-data")(version);
    return !!mcData.itemsByName?.[name];
  } catch {
    return false;
  }
}

function validateIntent(obj, owner, version = "1.21.1") {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return noneIntent("invalid_shape");
  if (!ALLOWED_TYPES.has(obj.type)) return noneIntent("unknown_type");
  if (typeof obj.confidence !== "number" || Number.isNaN(obj.confidence)) return noneIntent("missing_confidence");

  const confidence = Math.max(0, Math.min(1, obj.confidence));

  switch (obj.type) {
    case "follow":
    case "come":
    case "stalk": {
      const target = typeof obj.target === "string" && obj.target.trim() ? obj.target.trim() : owner;
      return { type: obj.type, target, source: "llm", confidence };
    }
    case "setCreepy": {
      if (typeof obj.value !== "boolean") return noneIntent("invalid_setcreepy");
      return { type: "setCreepy", value: obj.value, source: "llm", confidence };
    }
    case "attackMob": {
      const mobType = typeof obj.mobType === "string" ? obj.mobType.toLowerCase().trim() : "";
      if (!mobType) return noneIntent("missing_mob");
      const count = Number.isFinite(obj.count) ? Math.max(1, Math.min(64, Number(obj.count))) : 1;
      return { type: "attackMob", mobType, count, source: "llm", confidence };
    }
    case "craftItem": {
      const item = typeof obj.item === "string" ? obj.item.toLowerCase().trim() : "";
      const count = Number.isFinite(obj.count) ? Math.max(1, Math.min(64, Number(obj.count))) : 1;
      if (!item) return noneIntent("missing_craft_item");
      if (!isKnownCraftItem(item, version)) return noneIntent("unknown_craft_target");
      return { type: "craftItem", item, count, source: "llm", confidence };
    }
    case "explore": {
      const radius = Number.isFinite(obj.radius) ? Math.max(32, Math.min(500, Number(obj.radius))) : 200;
      const seconds = Number.isFinite(obj.seconds) ? Math.max(5, Math.min(300, Number(obj.seconds))) : 60;
      return { type: "explore", radius, seconds, source: "llm", confidence };
    }
    case "craftBasic":
    case "attackHostile":
    case "huntFood":
    case "harvest":
    case "stop":
    case "stopall":
    case "resume": {
      return { type: obj.type, source: "llm", confidence };
    }
    case "freeform": {
      if (typeof obj.message === "string" && obj.message.trim()) {
        return { type: "freeform", message: obj.message.trim(), source: "llm", confidence };
      }
      return noneIntent("invalid_freeform");
    }
    case "none":
    default:
      return { type: "none", source: "llm", confidence };
  }
}

function parseIntentText(text, owner, version = "1.21.1") {
  const parsed = parseJsonFromLlmText(text);
  if (!parsed.ok) return noneIntent(parsed.reasonCode || "invalid_json");
  return validateIntent(parsed.value, owner, version);
}

function parseOllamaIntentPayload(data, owner, version = "1.21.1") {
  const extracted = extractOllamaText(data);
  if (!extracted.ok) {
    return noneIntent(extracted.code, {
      unavailable: true,
      provider: "ollama",
      hasThinking: extracted.hasThinking
    });
  }
  return parseIntentText(extracted.text, owner, version);
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

async function llmParseIntent(message, cfg, state) {
  const model = cfg.llmModel || "gemini-1.5-flash";
  const provider = (cfg.llmProvider || "ollama").toLowerCase();

  const system = `You are an intent classifier. Return ONLY a single JSON object. No markdown, no prose.

Allowed intents (choose one):
{"type":"follow","target":"<player>","confidence":0.0-1.0}
{"type":"come","target":"<player>","confidence":0.0-1.0}
{"type":"stop","confidence":0.0-1.0}
{"type":"stopall","confidence":0.0-1.0}
{"type":"resume","confidence":0.0-1.0}
{"type":"setCreepy","value":true|false,"confidence":0.0-1.0}
{"type":"stalk","target":"<player>","confidence":0.0-1.0}
{"type":"harvest","confidence":0.0-1.0}
{"type":"craftBasic","confidence":0.0-1.0}
{"type":"craftItem","item":"wooden_sword","count":1,"confidence":0.0-1.0}
{"type":"explore","radius":200,"seconds":60,"confidence":0.0-1.0}
{"type":"attackMob","mobType":"pig","count":1,"confidence":0.0-1.0}
{"type":"attackHostile","confidence":0.0-1.0}
{"type":"huntFood","confidence":0.0-1.0}
{"type":"freeform","message":"<request>","confidence":0.0-1.0}
{"type":"none","confidence":0.0-1.0}

Rules:
- Classify ONLY actionable game commands. Casual chat should be {"type":"none","confidence":0.05}.
- Only use follow/come if the message explicitly says "follow me" or "come to me".
- Default target is cfg.owner if not provided.
- "stop all" / "stop everything" / "!stopall" => stopall.
- "resume" => resume.
- Mentions of creepy/stalk => setCreepy true or stalk depending on wording.
- Use attackMob for explicit mob targets like "kill a pig" and set count if requested.
- Use attackHostile for "kill hostile mobs".
- Use huntFood for food hunting requests.
- For requests like "seek a village", "go explore", "craft tools" choose supported direct intent if possible, else freeform.
- For explicit item craft requests like "craft me a wooden sword", use craftItem with count.
- Output must be valid JSON only, no trailing text.`;

  const prompt = `cfg.owner="${cfg.owner}"
state.creepy=${!!state.creepy}
message="${message}"
JSON:`;

  const controller = new AbortController();
  const timeout = cfg?.disableTimeouts === true
    ? null
    : setTimeout(() => controller.abort(), cfg.llmTimeoutMs || 3000);

  try {
    if (provider === "groq") {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) return noneIntent("llm_unavailable", { unavailable: true, provider });
      const url = "https://api.groq.com/openai/v1/chat/completions";
      const body = {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt }
        ],
        temperature: 0.1
      };
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) {
        return noneIntent("llm_http_error", { unavailable: true, provider, status: res.status });
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim() || "";
      return parseIntentText(text, cfg.owner, cfg.version || "1.21.1");
    }

    if (provider === "gemini") {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return noneIntent("llm_unavailable", { unavailable: true, provider });
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const body = {
        contents: [{
          role: "user",
          parts: [{ text: `${system}\n\n${prompt}` }]
        }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json"
        }
      };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) {
        return noneIntent("llm_http_error", { unavailable: true, provider, status: res.status });
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
      return parseIntentText(text, cfg.owner, cfg.version || "1.21.1");
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
      return noneIntent("llm_http_error", { unavailable: true, provider, status: res.status });
    }
    const data = await res.json();
    return parseOllamaIntentPayload(data, cfg.owner, cfg.version || "1.21.1");
  } catch (e) {
    const reason = classifyLlmError(provider, e);
    return noneIntent(reason, { unavailable: true, provider, error: String(e) });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

module.exports = { llmParseIntent, validateIntent, noneIntent, parseIntentText, parseOllamaIntentPayload };
