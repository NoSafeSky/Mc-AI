function clampPositive(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function normalizeProgressKind(value) {
  const kind = String(value || "").toLowerCase().trim();
  return kind === "heartbeat" ? "heartbeat" : "state";
}

class TaskSupervisor {
  constructor(options = {}) {
    this.bot = options.bot;
    this.runCtx = options.runCtx || null;
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.cfg = options.cfg || {};
    this.timeoutsDisabled = this.cfg.disableTimeouts === true;
    this.noProgressMs = clampPositive(this.cfg.taskNoProgressTimeoutSec, 15) * 1000;
    this.heartbeatMs = clampPositive(this.cfg.taskProgressHeartbeatSec, 3) * 1000;
    this._lastHeartbeatAt = 0;
    this._stalled = false;
    this._ended = false;
    this._timer = null;

    const now = Date.now();
    this.state = {
      id: this.runCtx?.id || null,
      intentType: options.intentType || null,
      goalId: options.goalId || null,
      startedAt: now,
      currentStepId: null,
      currentStepAction: null,
      lastProgressAt: now,
      lastStateProgressAt: now,
      lastHeartbeatAt: now,
      lastProgressKind: "state",
      lastProgressMsg: "task started",
      attempt: 0,
      gatherRingIndex: null,
      status: "running"
    };

    this.lastFailure = null;
    this._startTicker();
  }

  _startTicker() {
    if (this.timeoutsDisabled) return;
    if (this._timer) return;
    const tickMs = Math.max(
      25,
      Math.min(
        250,
        Math.floor(Math.min(this.noProgressMs, this.heartbeatMs) / 3)
      )
    );
    this._timer = setInterval(() => this._tick(), tickMs);
    if (typeof this._timer.unref === "function") this._timer.unref();
  }

  _emitProgressHeartbeat(message = null, progressKind = "heartbeat") {
    const now = Date.now();
    if (now - this._lastHeartbeatAt < this.heartbeatMs) return;
    this._lastHeartbeatAt = now;
    this.state.lastHeartbeatAt = now;
    this.log({
      type: "task_progress",
      taskId: this.state.id,
      intent: this.state.intentType,
      goalId: this.state.goalId,
      stepId: this.state.currentStepId,
      stepAction: this.state.currentStepAction,
      attempt: this.state.attempt,
      gatherRingIndex: this.state.gatherRingIndex,
      elapsedMs: now - this.state.startedAt,
      progressKind: normalizeProgressKind(progressKind),
      msg: message || this.state.lastProgressMsg || "running"
    });
  }

  _tick() {
    if (this.timeoutsDisabled) return;
    if (this._ended || this._stalled) return;
    const now = Date.now();
    this._emitProgressHeartbeat(null, "heartbeat");
    if (now - this.state.lastStateProgressAt < this.noProgressMs) return;

    this._stalled = true;
    this.state.status = "fail";
    const step = this.state.currentStepAction || this.state.intentType || "task";
    const inactivityMs = now - this.state.lastStateProgressAt;
    const reason = `stalled at ${step}`;
    const nextNeed = "move to open area";
    this.lastFailure = {
      code: "task_stalled",
      reason,
      nextNeed
    };

    if (this.runCtx) {
      this.runCtx.stallResult = {
        status: "fail",
        code: "task_stalled",
        reason,
        nextNeed,
        recoverable: false
      };
      this.runCtx.cancelled = true;
    }

    try {
      this.bot?.pathfinder?.setGoal?.(null);
      this.bot?.clearControlStates?.();
    } catch {}

    this.log({
      type: "task_stall_fail",
      taskId: this.state.id,
      intent: this.state.intentType,
      goalId: this.state.goalId,
      stepId: this.state.currentStepId,
      stepAction: this.state.currentStepAction,
      reason,
      nextNeed,
      elapsedMs: now - this.state.startedAt,
      inactivityMs
    });
  }

  setGoalId(goalId) {
    if (!goalId) return;
    this.state.goalId = goalId;
  }

  setStep(stepId, stepAction, extra = {}) {
    if (this._ended) return;
    if (stepId != null) this.state.currentStepId = stepId;
    if (stepAction != null) this.state.currentStepAction = stepAction;
    if (Number.isFinite(extra.attempt)) this.state.attempt = extra.attempt;
    if (Number.isFinite(extra.gatherRingIndex)) this.state.gatherRingIndex = extra.gatherRingIndex;
    this.reportProgress(extra.msg || `step ${stepAction || "running"}`, {
      ...extra,
      progressKind: extra.progressKind || "state"
    });
  }

  reportProgress(message, extra = {}) {
    if (this._ended) return;
    const now = Date.now();
    const progressKind = normalizeProgressKind(extra.progressKind);
    if (Number.isFinite(extra.attempt)) this.state.attempt = extra.attempt;
    if (Number.isFinite(extra.gatherRingIndex)) this.state.gatherRingIndex = extra.gatherRingIndex;
    if (extra.stepId != null) this.state.currentStepId = extra.stepId;
    if (extra.stepAction != null) this.state.currentStepAction = extra.stepAction;
    if (progressKind === "state") {
      this.state.lastProgressAt = now;
      this.state.lastStateProgressAt = now;
    }
    this.state.lastHeartbeatAt = now;
    this.state.lastProgressKind = progressKind;
    this.state.lastProgressMsg = message || this.state.lastProgressMsg || "running";
    this._emitProgressHeartbeat(message, progressKind);
  }

  finish(status, failure = null) {
    if (this._ended) return;
    this._ended = true;
    this.state.status = status || this.state.status || "running";
    if (failure) this.lastFailure = failure;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  getState() {
    const now = Date.now();
    return {
      ...this.state,
      elapsedMs: now - this.state.startedAt
    };
  }

  getLastFailure() {
    return this.lastFailure;
  }

  isStalled() {
    return this._stalled;
  }
}

module.exports = {
  TaskSupervisor
};
