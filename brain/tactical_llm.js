const fetch = require("node-fetch");
const { buildOllamaGenerateBody, extractOllamaText } = require("./llm_ollama");
const { parseJsonFromLlmText } = require("./llm_json");

const callTimes = [];

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function cleanupCalls(now) {
  while (callTimes.length && now - callTimes[0] > 60_000) {
    callTimes.shift();
  }
}

function rateLimited(cfg = {}) {
  const now = Date.now();
  cleanupCalls(now);
  const max = Math.max(1, Number(cfg.tacticalLlmMaxCallsPerMin || 12));
  if (callTimes.length >= max) return true;
  callTimes.push(now);
  return false;
}

function buildSystemPrompt() {
  return [
    "You are a tactical Minecraft advisor.",
    "Return ONLY strict JSON object.",
    "Never output chain-of-thought.",
    "Schema:",
    '{"kind":"none|retreat|focus_target|position","confidence":0.0,"target":null,"retreat":false,"positionHint":null,"reason":"", "ttlSec":8}',
    "Use short values. If uncertain, kind=none."
  ].join("\n");
}

function buildPrompt(eventType, payload = {}) {
  const safePayload = JSON.stringify(payload || {});
  return [
    `eventType=${eventType}`,
    `payload=${safePayload}`
  ].join("\n");
}

function validateHint(raw, minConfidence) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const kind = String(raw.kind || "none").trim().toLowerCase();
  const allowedKinds = new Set(["none", "retreat", "focus_target", "position"]);
  if (!allowedKinds.has(kind)) return null;
  const confidence = clamp(raw.confidence, 0, 1, 0);
  if (confidence < minConfidence) return null;
  return {
    kind,
    confidence,
    target: raw.target ? String(raw.target).trim().toLowerCase() : null,
    retreat: !!raw.retreat,
    positionHint: raw.positionHint ? String(raw.positionHint).trim() : null,
    reason: raw.reason ? String(raw.reason).trim() : "",
    ttlSec: clamp(raw.ttlSec, 2, 60, 8)
  };
}

async function suggestTacticalHint(eventType, payload, cfg = {}, log = () => {}) {
  if (cfg.tacticalLlmEnabled === false) return null;
  if (cfg.tacticalLlmEventOnly !== false && !eventType) return null;
  if (rateLimited(cfg)) {
    log({ type: "tactical_llm_hint_reject", reasonCode: "rate_limited", eventType });
    return null;
  }

  const provider = String(cfg.tacticalLlmProvider || cfg.llmProvider || "ollama").toLowerCase();
  const model = cfg.tacticalLlmModel || cfg.llmModel || "qwen3:14b";
  const minConfidence = clamp(cfg.tacticalLlmMinConfidence, 0, 1, 0.65);
  const timeoutMs = Math.max(300, Number(cfg.tacticalLlmTimeoutMs || 1800));

  log({
    type: "tactical_llm_request",
    provider,
    model,
    eventType
  });

  const controller = new AbortController();
  const timeout = cfg?.disableTimeouts === true ? null : setTimeout(() => controller.abort(), timeoutMs);
  try {
    let parsed = null;
    if (provider === "groq") {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) {
        log({ type: "tactical_llm_hint_reject", reasonCode: "missing_api_key", provider, eventType });
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
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: buildPrompt(eventType, payload) }
          ],
          temperature: 0.1,
          max_tokens: 180
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        log({ type: "tactical_llm_hint_reject", reasonCode: "http_error", status: res.status, provider, eventType });
        return null;
      }
      const data = await res.json();
      const text = String(data?.choices?.[0]?.message?.content || "").trim();
      if (!text) {
        log({ type: "tactical_llm_hint_reject", reasonCode: "empty_response", provider, eventType });
        return null;
      }
      const parsedJson = parseJsonFromLlmText(text);
      if (!parsedJson.ok) {
        log({
          type: "tactical_llm_hint_reject",
          reasonCode: parsedJson.reasonCode || "invalid_json",
          provider,
          eventType
        });
        return null;
      }
      parsed = parsedJson.value;
    } else if (provider === "ollama") {
      const body = buildOllamaGenerateBody({
        model,
        system: buildSystemPrompt(),
        prompt: buildPrompt(eventType, payload),
        temperature: 0.1,
        numPredict: 180,
        disableThinking: cfg.ollamaDisableThinking !== false
      });

      const res = await fetch("http://127.0.0.1:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) {
        log({ type: "tactical_llm_hint_reject", reasonCode: "http_error", status: res.status, provider, eventType });
        return null;
      }
      const data = await res.json();
      const extracted = extractOllamaText(data);
      if (!extracted.ok) {
        log({
          type: "tactical_llm_hint_reject",
          reasonCode: extracted.code || "empty_response",
          hasThinking: !!extracted.hasThinking,
          provider,
          eventType
        });
        return null;
      }
      const parsedJson = parseJsonFromLlmText(extracted.text || "");
      if (!parsedJson.ok) {
        log({
          type: "tactical_llm_hint_reject",
          reasonCode: parsedJson.reasonCode || "invalid_json",
          provider,
          eventType
        });
        return null;
      }
      parsed = parsedJson.value;
    } else {
      log({ type: "tactical_llm_hint_reject", reasonCode: "unsupported_provider", provider, eventType });
      return null;
    }

    const hint = validateHint(parsed, minConfidence);
    if (!hint || hint.kind === "none") {
      log({
        type: "tactical_llm_hint_reject",
        reasonCode: hint ? "none_hint" : "low_confidence_or_invalid",
        provider,
        eventType
      });
      return null;
    }
    log({
      type: "tactical_llm_hint_accept",
      eventType,
      hint
    });
    return hint;
  } catch (e) {
    log({
      type: "tactical_llm_hint_reject",
      reasonCode: /AbortError/i.test(String(e?.name || e)) ? "timeout" : "provider_error",
      error: String(e),
      eventType
    });
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

module.exports = {
  suggestTacticalHint
};
