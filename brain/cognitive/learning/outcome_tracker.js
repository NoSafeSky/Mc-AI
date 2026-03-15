class OutcomeTracker {
  constructor(memoryManager, skillConfidence, log = () => {}) {
    this.memory = memoryManager;
    this.skillConfidence = skillConfidence;
    this.log = typeof log === "function" ? log : () => {};
  }

  record({ intent, result, isOwner = true, context = {} }) {
    const type = String(intent?.type || "unknown");
    const status = String(result?.status || "fail");
    const confidence = this.skillConfidence?.update(type, status);
    this.memory?.recordEpisode({
      type: "task_outcome",
      tags: ["task", type, status],
      importance: status === "success" ? 0.6 : 0.9,
      context: {
        intentType: type,
        isOwner,
        nextNeed: result?.nextNeed || null,
        code: result?.code || null,
        ...context
      },
      outcome: {
        status,
        reason: result?.reason || null,
        code: result?.code || null
      }
    });
    this.memory?.updateProcedural(type, status, {
      code: result?.code || null
    });
    this.log({
      type: "cognitive_outcome",
      intentType: type,
      status,
      confidence
    });
    return { status, confidence };
  }
}

module.exports = { OutcomeTracker };

