const fetch = require("node-fetch");
const { buildOllamaGenerateBody, extractOllamaText } = require("./llm_ollama");

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

  if (provider !== "ollama") {
    log({ type: "tactical_llm_hint_reject", reasonCode: "unsupported_provider", provider, eventType });
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
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
      log({ type: "tactical_llm_hint_reject", reasonCode: "http_error", status: res.status, eventType });
      return null;
    }
    const data = await res.json();
    const extracted = extractOllamaText(data);
    if (!extracted.ok) {
      log({
        type: "tactical_llm_hint_reject",
        reasonCode: extracted.code || "empty_response",
        hasThinking: !!extracted.hasThinking,
        eventType
      });
      return null;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(String(extracted.text || "").trim());
    } catch {
      log({ type: "tactical_llm_hint_reject", reasonCode: "invalid_json", eventType });
      return null;
    }
    const hint = validateHint(parsed, minConfidence);
    if (!hint || hint.kind === "none") {
      log({
        type: "tactical_llm_hint_reject",
        reasonCode: hint ? "none_hint" : "low_confidence_or_invalid",
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
    clearTimeout(timeout);
  }
}

module.exports = {
  suggestTacticalHint
};
