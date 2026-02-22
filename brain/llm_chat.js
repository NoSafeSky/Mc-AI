const fetch = require("node-fetch");
const { buildOllamaGenerateBody, extractOllamaText } = require("./llm_ollama");

let lastChatFailure = null;

function setLastChatFailure(failure) {
  lastChatFailure = failure || null;
}

function getLastChatFailure() {
  return lastChatFailure;
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

function parseOllamaChatPayload(data, provider = "ollama") {
  const extracted = extractOllamaText(data);
  if (!extracted.ok) {
    setLastChatFailure({
      reason: extracted.code,
      provider,
      hasThinking: extracted.hasThinking,
      detail: extracted.reason
    });
    return null;
  }
  setLastChatFailure(null);
  return extracted.text;
}

async function llmChatReply(message, cfg, history = [], opts = {}) {
  setLastChatFailure(null);
  const provider = (cfg.llmProvider || "ollama").toLowerCase();
  const model = cfg.llmModel || "gemini-3.0-flash";
  const maxTokens = Number.isFinite(opts.maxTokens) ? opts.maxTokens : (cfg.chatMaxTokens || 80);

  const system = `You are a friendly Minecraft bot assistant. Reply in 1 short sentence. No emojis. Avoid commands. Use recent chat context if provided.`;
  const historyText = history.length
    ? `Recent chat:\n${history.map((h) => `${h.role}: ${h.text}`).join("\n")}`
    : "";
  const prompt = `${historyText}\nPlayer says: "${message}"\nReply:`;

  const controller = new AbortController();
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : (cfg.llmTimeoutMs || 3000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (provider === "groq") {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) {
        setLastChatFailure({ reason: "llm_unavailable", provider });
        return null;
      }
      const url = "https://api.groq.com/openai/v1/chat/completions";
      const body = {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt }
        ],
        temperature: 0.6,
        max_tokens: maxTokens
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
        const errText = await res.text().catch(() => "");
        console.log("Groq chat HTTP", res.status, errText.slice(0, 200));
        setLastChatFailure({ reason: "llm_http_error", provider, status: res.status });
        return null;
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim() || null;
      if (!text) {
        console.log("Groq chat empty response");
        setLastChatFailure({ reason: "llm_empty_response", provider });
        return null;
      }
      return text;
    }

    if (provider === "gemini") {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        setLastChatFailure({ reason: "llm_unavailable", provider });
        return null;
      }
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const body = {
        contents: [{ role: "user", parts: [{ text: `${system}\n\n${prompt}` }] }],
        generationConfig: { temperature: 0.6, maxOutputTokens: maxTokens }
      };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.log("Gemini chat HTTP", res.status, errText.slice(0, 200));
        setLastChatFailure({ reason: "llm_http_error", provider, status: res.status });
        return null;
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
      if (!text) {
        setLastChatFailure({ reason: "llm_empty_response", provider });
        return null;
      }
      return text;
    }

    const mode = (cfg.ollamaRequestMode || "stable").toLowerCase();
    const disableThinking = mode === "stable" ? cfg.ollamaDisableThinking !== false : false;
    const body = buildOllamaGenerateBody({
      model,
      system,
      prompt,
      temperature: 0.6,
      numPredict: maxTokens,
      disableThinking
    });

    const res = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.log("Ollama chat HTTP", res.status, errText.slice(0, 200));
      setLastChatFailure({ reason: "llm_http_error", provider, status: res.status });
      return null;
    }
    const data = await res.json();
    return parseOllamaChatPayload(data, provider);
  } catch (e) {
    setLastChatFailure({
      reason: classifyLlmError(provider, e),
      provider,
      error: String(e)
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { llmChatReply, getLastChatFailure, parseOllamaChatPayload };
