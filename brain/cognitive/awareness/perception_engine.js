class PerceptionEngine {
  constructor({ worldModel, socialTracker, eventBus, log, cfg = {} }) {
    this.worldModel = worldModel;
    this.socialTracker = socialTracker;
    this.eventBus = eventBus;
    this.log = typeof log === "function" ? log : () => {};
    this.cfg = cfg;
    this.timers = [];
  }

  interval(name, fallback) {
    const ticks = this.cfg?.cognitive?.ticks || {};
    const value = Number(ticks[name] || fallback);
    return Math.max(500, value);
  }

  start() {
    this.stop();
    const fastMs = this.interval("fastMs", 2000);
    const mediumMs = this.interval("mediumMs", 10000);
    const slowMs = this.interval("slowMs", 60000);
    this.log({ type: "cognitive_perception_start", fastMs, mediumMs, slowMs });
    this.fastTick();
    this.mediumTick();
    this.slowTick();
    this.timers.push(setInterval(() => this.fastTick(), fastMs));
    this.timers.push(setInterval(() => this.mediumTick(), mediumMs));
    this.timers.push(setInterval(() => this.slowTick(), slowMs));
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  emitChanges(kind, sectionResult = {}) {
    for (const [section, result] of Object.entries(sectionResult || {})) {
      if (!result?.changed) continue;
      this.eventBus.emit("perception:change", {
        kind,
        section,
        changes: result.changes || [],
        snapshot: this.worldModel.getSnapshot()
      });
      this.log({
        type: "cognitive_perception_change",
        kind,
        section,
        changes: result.changes || []
      });
    }
  }

  fastTick() {
    const result = this.worldModel.applyFastTick();
    this.emitChanges("fast", result);
    this.eventBus.emit("perception:fast", {
      snapshot: this.worldModel.getSnapshot()
    });
  }

  mediumTick() {
    const result = this.worldModel.applyMediumTick();
    this.emitChanges("medium", result);
    this.eventBus.emit("perception:medium", {
      snapshot: this.worldModel.getSnapshot()
    });
  }

  slowTick() {
    const socialSummary = this.socialTracker.getSummary();
    const result = this.worldModel.applySlowTick(socialSummary);
    this.emitChanges("slow", result);
    this.eventBus.emit("perception:slow", {
      snapshot: this.worldModel.getSnapshot()
    });
  }
}

module.exports = { PerceptionEngine };

