const { llmPlanRoute, getLastPlanFailure } = require("./llm_plan");
const { llmChatReply, getLastChatFailure } = require("./llm_chat");

let lastRouteFailure = null;

function setLastRouteFailure(failure) {
  lastRouteFailure = failure || null;
}

function getLastRouteFailure() {
  return lastRouteFailure;
}

function routeNone(reasonCode = "none", confidence = 0) {
  return {
    kind: "none",
    confidence,
    source: "llm",
    reasonCode
  };
}

async function routePromptWithLLM(text, cfg, state, context = {}) {
  const message = String(text || "").trim();
  if (!message) return routeNone("empty_input", 0);

  setLastRouteFailure(null);

  const isOwner = !!context.isOwner;
  const owner = context.owner || cfg.owner;
  const history = Array.isArray(context.history) ? context.history : [];
  const planFn = context.planFn || llmPlanRoute;
  const chatFn = context.chatFn || llmChatReply;

  const actionMinConfidence = Number.isFinite(Number(cfg.llmActionMinConfidence))
    ? Number(cfg.llmActionMinConfidence)
    : 0.7;
  const chatMinConfidence = Number.isFinite(Number(cfg.llmChatMinConfidence))
    ? Number(cfg.llmChatMinConfidence)
    : 0.55;

  if (!isOwner) {
    if (cfg.llmRouteNonOwnerChat === false) {
      return routeNone("chat_disabled", 0);
    }

    const reply = await chatFn(message, cfg, history, {
      timeoutMs: cfg.chatReplyTimeoutMs || cfg.llmTimeoutMs || 3000,
      maxTokens: cfg.chatMaxTokens || 80
    });

    if (reply && reply.trim()) {
      return {
        kind: "chat",
        confidence: 1,
        reply: reply.trim(),
        source: "llm"
      };
    }

    const failure = getLastChatFailure();
    if (failure) setLastRouteFailure({ ...failure, where: "chat" });
    return routeNone(failure?.reason || "chat_no_reply", 0);
  }

  const route = await planFn(message, cfg, state, {
    owner,
    isOwner,
    allowAction: true,
    allowChat: true
  });

  if (!route) {
    const failure = getLastPlanFailure();
    if (failure) setLastRouteFailure({ ...failure, where: "plan" });
    return routeNone(failure?.reason || "llm_plan_unavailable", 0);
  }

  if (route.kind === "action") {
    const confidence = Number(route.confidence || 0);
    if (confidence < actionMinConfidence) {
      return routeNone("low_action_confidence", confidence);
    }
    return {
      kind: "action",
      confidence,
      goals: Array.isArray(route.goals) ? route.goals : [],
      source: "llm",
      notes: route.notes || null
    };
  }

  if (route.kind === "chat") {
    const confidence = Number(route.confidence || 0);
    if (confidence < chatMinConfidence) {
      return routeNone("low_chat_confidence", confidence);
    }
    if (typeof route.reply === "string" && route.reply.trim()) {
      return {
        kind: "chat",
        confidence,
        reply: route.reply.trim(),
        source: "llm"
      };
    }
    return routeNone("chat_no_reply", confidence);
  }

  if (route.kind === "reject") {
    return {
      kind: "reject",
      confidence: Number(route.confidence || 0),
      reasonCode: route.reasonCode || "unsupported_request",
      source: "llm"
    };
  }

  return routeNone("llm_none", Number(route.confidence || 0));
}

module.exports = {
  routePromptWithLLM,
  getLastRouteFailure
};
