let queueSeq = 0;

function nowMs() {
  return Date.now();
}

function normalizePolicy(cfg = {}) {
  const raw = String(cfg.assistantQueuePolicy || "fifo").toLowerCase().trim();
  return raw === "fifo" ? "fifo" : "fifo";
}

function queueMax(cfg = {}) {
  const n = Number(cfg.assistantQueueMax || 10);
  if (!Number.isFinite(n) || n < 1) return 10;
  return Math.floor(n);
}

function queueEnabled(cfg = {}) {
  return cfg.assistantQueueEnabled !== false;
}

function enqueueCommand(queue, payload, cfg = {}) {
  if (!Array.isArray(queue)) {
    return { ok: false, code: "invalid_queue", reason: "queue must be an array" };
  }
  if (!queueEnabled(cfg)) {
    return { ok: false, code: "queue_disabled", reason: "assistant queue disabled" };
  }

  const max = queueMax(cfg);
  if (queue.length >= max) {
    return { ok: false, code: "queue_full", reason: `queue full (${max})` };
  }

  const policy = normalizePolicy(cfg);
  const item = {
    id: `q_${nowMs()}_${++queueSeq}`,
    from: payload?.from || null,
    rawText: payload?.rawText || "",
    intent: payload?.intent || null,
    createdAt: nowMs(),
    priority: Number.isFinite(Number(payload?.priority)) ? Number(payload.priority) : 0
  };

  if (policy === "fifo") {
    queue.push(item);
  } else {
    queue.push(item);
  }
  return { ok: true, item };
}

function dequeueCommand(queue) {
  if (!Array.isArray(queue)) {
    return { ok: false, code: "invalid_queue", reason: "queue must be an array" };
  }
  if (!queue.length) {
    return { ok: false, code: "queue_empty", reason: "queue empty" };
  }
  const item = queue.shift();
  return { ok: true, item };
}

function clearQueue(queue) {
  if (!Array.isArray(queue)) return { ok: false, code: "invalid_queue", reason: "queue must be an array", cleared: 0 };
  const cleared = queue.length;
  queue.length = 0;
  return { ok: true, cleared };
}

function queueSummary(queue) {
  if (!Array.isArray(queue) || queue.length === 0) {
    return {
      size: 0,
      first: null,
      items: []
    };
  }
  return {
    size: queue.length,
    first: queue[0],
    items: queue.slice(0, 5)
  };
}

module.exports = {
  enqueueCommand,
  dequeueCommand,
  clearQueue,
  queueSummary,
  queueEnabled,
  queueMax,
  normalizePolicy
};
