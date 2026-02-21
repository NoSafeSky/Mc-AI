const fetch = require("node-fetch");

const ALLOWED_TYPES = new Set([
  "follow",
  "come",
  "stop",
  "stopall",
  "resume",
  "setCreepy",
  "stalk",
  "harvest",
  "freeform",
  "none"
]);

function validateIntent(obj, owner) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { type: "none" };
  if (!ALLOWED_TYPES.has(obj.type)) return { type: "none" };

  switch (obj.type) {
    case "follow":
    case "come":
    case "stalk": {
      const target = typeof obj.target === "string" && obj.target.trim() ? obj.target.trim() : owner;
      return { type: obj.type, target };
    }
    case "setCreepy": {
      if (typeof obj.value !== "boolean") return { type: "none" };
      return { type: "setCreepy", value: obj.value };
    }
    case "stop":
    case "stopall":
    case "resume":
    case "freeform":
    case "none":
    default:
      if (obj.type === "freeform" && typeof obj.message === "string") {
        return { type: "freeform", message: obj.message };
      }
      return { type: obj.type };
  }
}

async function llmParseIntent(message, cfg, state) {
  const model = cfg.llmModel || "gemini-1.5-flash";
  const provider = (cfg.llmProvider || "ollama").toLowerCase();

  const system = `You are an intent classifier. Return ONLY a single JSON object. No markdown, no prose.

Allowed intents (choose one):
{"type":"follow","target":"<player>"}
{"type":"come","target":"<player>"}
{"type":"stop"}
{"type":"stopall"}
{"type":"resume"}
{"type":"setCreepy","value":true|false}
{"type":"stalk","target":"<player>"}
{"type":"harvest"}
{"type":"freeform","message":"<request>"}
{"type":"none"}

Rules:
- Only use follow/come if the message explicitly says "follow me" or "come to me".
- Default target is cfg.owner if not provided.
- "stop all" / "stop everything" / "!stopall" => stopall.
- "resume" => resume.
- Mentions of creepy/stalk => setCreepy true or stalk depending on wording.
- For requests like "seek a village", "go explore", "craft", "kill mobs" => use freeform.
- If unrelated => none.
- Output must be valid JSON only, no trailing text.`;

  const prompt = `cfg.owner="${cfg.owner}"
state.creepy=${!!state.creepy}
message="${message}"
JSON:`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.llmTimeoutMs || 3000);

  try {
    if (provider === "groq") {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) return { type: "none" };
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
      if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim() || "";
      try {
        const parsed = JSON.parse(text);
        return validateIntent(parsed, cfg.owner);
      } catch {
        return { type: "none" };
      }
    }

    if (provider === "gemini") {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return { type: "none" };
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
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
      try {
        const parsed = JSON.parse(text);
        return validateIntent(parsed, cfg.owner);
      } catch {
        return { type: "none" };
      }
    }

    const body = {
      model,
      system,
      prompt,
      stream: false,
      options: { temperature: 0.1 }
    };

    const res = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    const text = (data.response || "").trim();
    try {
      const parsed = JSON.parse(text);
      return validateIntent(parsed, cfg.owner);
    } catch {
      return { type: "none" };
    }
  } catch (e) {
    return { type: "none" };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { llmParseIntent };
