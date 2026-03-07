function stripThinkTags(text) {
  const raw = String(text || "");
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<think>[\s\S]*$/gi, " ")
    .replace(/<\/think>/gi, " ")
    .trim();
}

function stripCodeFences(text) {
  return String(text || "")
    .replace(/```json/gi, "```")
    .replace(/```/g, " ")
    .trim();
}

function pushCandidate(candidates, seen, text, mode) {
  const value = String(text || "").trim();
  if (!value) return;
  if (seen.has(value)) return;
  seen.add(value);
  candidates.push({ text: value, mode });
}

function parseRawJson(text, mode) {
  try {
    return {
      ok: true,
      value: JSON.parse(text),
      raw: text,
      mode
    };
  } catch (error) {
    return {
      ok: false,
      error
    };
  }
}

function findFirstJsonSegment(text) {
  const input = String(text || "");
  const len = input.length;
  for (let i = 0; i < len; i += 1) {
    const start = input[i];
    if (start !== "{" && start !== "[") continue;
    const stack = [start];
    let inString = false;
    let escaped = false;
    for (let j = i + 1; j < len; j += 1) {
      const ch = input[j];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === "\"") {
          inString = false;
        }
        continue;
      }

      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{" || ch === "[") {
        stack.push(ch);
        continue;
      }
      if (ch !== "}" && ch !== "]") continue;

      const top = stack[stack.length - 1];
      if ((top === "{" && ch === "}") || (top === "[" && ch === "]")) {
        stack.pop();
        if (!stack.length) {
          return input.slice(i, j + 1);
        }
        continue;
      }
      break;
    }
  }
  return null;
}

function parseJsonFromLlmText(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) {
    return {
      ok: false,
      reasonCode: "llm_empty_response",
      reason: "empty response"
    };
  }

  const candidates = [];
  const seen = new Set();
  pushCandidate(candidates, seen, raw, "raw");
  const noFences = stripCodeFences(raw);
  pushCandidate(candidates, seen, noFences, "no_fence");
  const noThink = stripThinkTags(noFences);
  pushCandidate(candidates, seen, noThink, "no_think");

  let lastError = null;
  for (const candidate of candidates) {
    const direct = parseRawJson(candidate.text, candidate.mode);
    if (direct.ok) return direct;
    lastError = direct.error;

    const segment = findFirstJsonSegment(candidate.text);
    if (!segment) continue;
    const segmented = parseRawJson(segment, `${candidate.mode}_segment`);
    if (segmented.ok) return segmented;
    lastError = segmented.error;
  }

  return {
    ok: false,
    reasonCode: "invalid_json",
    reason: String(lastError || "no parseable JSON object found")
  };
}

module.exports = {
  parseJsonFromLlmText,
  stripThinkTags
};
