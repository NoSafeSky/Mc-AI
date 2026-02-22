function buildOllamaGenerateBody({
  model,
  system,
  prompt,
  temperature = 0.2,
  numPredict,
  disableThinking = true
}) {
  const body = {
    model,
    system,
    prompt,
    stream: false,
    options: { temperature }
  };

  if (Number.isFinite(numPredict)) {
    body.options.num_predict = Number(numPredict);
  }

  if (disableThinking) {
    body.think = false;
  }

  return body;
}

function extractOllamaText(data) {
  const text = typeof data?.response === "string" ? data.response.trim() : "";
  const hasThinking = typeof data?.thinking === "string" && data.thinking.trim().length > 0;

  if (text) {
    return { ok: true, text };
  }

  if (hasThinking) {
    return {
      ok: false,
      code: "llm_thinking_only_response",
      reason: "ollama returned thinking text without final response",
      hasThinking: true
    };
  }

  return {
    ok: false,
    code: "llm_empty_response",
    reason: "ollama returned empty response",
    hasThinking: false
  };
}

module.exports = {
  buildOllamaGenerateBody,
  extractOllamaText
};
