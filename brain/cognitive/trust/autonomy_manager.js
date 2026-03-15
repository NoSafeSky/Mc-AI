const LEVELS = [
  "ask_everything",
  "ask_most",
  "auto_low_risk",
  "auto_medium_risk",
  "auto_high_trust"
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

class AutonomyManager {
  constructor(cfg = {}, initialState = {}) {
    this.cfg = cfg;
    const trustCfg = cfg?.cognitive?.trust || {};
    const start = Number(trustCfg.start ?? 0.1);
    this.state = {
      trustScore: Number.isFinite(start) ? clamp(start, 0, 1) : 0.1,
      level: "ask_everything",
      lastUpdated: Date.now(),
      advisoryOnly: cfg?.cognitive?.autonomyPolicy?.advisoryOnly !== false,
      ...initialState
    };
    this.refreshLevel();
  }

  refreshLevel() {
    const score = Number(this.state.trustScore || 0);
    if (score >= 0.8) this.state.level = LEVELS[4];
    else if (score >= 0.6) this.state.level = LEVELS[3];
    else if (score >= 0.4) this.state.level = LEVELS[2];
    else if (score >= 0.2) this.state.level = LEVELS[1];
    else this.state.level = LEVELS[0];
  }

  updateFromTaskResult(result = {}) {
    const trustCfg = this.cfg?.cognitive?.trust || {};
    const successDelta = Number(trustCfg.successDelta ?? 0.02);
    const failDelta = Number(trustCfg.failDelta ?? -0.05);
    const status = String(result?.status || "");
    let next = Number(this.state.trustScore || 0);
    if (status === "success") next += successDelta;
    if (status === "fail" || status === "timeout") next += failDelta;
    this.state.trustScore = clamp(next, 0, 1);
    this.state.lastUpdated = Date.now();
    this.refreshLevel();
    return this.getState();
  }

  getState() {
    return { ...this.state };
  }
}

module.exports = {
  AutonomyManager,
  LEVELS
};

