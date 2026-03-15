class Monologue {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.calls = [];
  }

  allowed() {
    const budget = this.cfg?.cognitive?.llmBudget || {};
    if (budget.monologueEnabled !== true) return false;
    const maxPer5Min = Math.max(1, Number(budget.monologueMaxPer5Min || 3));
    const now = Date.now();
    this.calls = this.calls.filter((ts) => (now - ts) <= 300000);
    return this.calls.length < maxPer5Min;
  }

  create(intent, confidence, mood) {
    if (!this.allowed()) return null;
    this.calls.push(Date.now());
    const type = String(intent?.type || "task");
    const conf = Number.isFinite(Number(confidence)) ? Number(confidence) : 0.5;
    if (conf < 0.35) return `monologue: low confidence for ${type}, proceed carefully`;
    if (String(mood || "") === "frustrated") return `monologue: keep ${type} deterministic and bounded`;
    return `monologue: execute ${type} with current deterministic plan`;
  }
}

module.exports = { Monologue };

