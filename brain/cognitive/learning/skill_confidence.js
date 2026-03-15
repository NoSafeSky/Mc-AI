class SkillConfidence {
  constructor(initial = {}) {
    this.alpha = 0.25;
    this.scores = { ...(initial || {}) };
  }

  get(skill, fallback = 0.5) {
    const key = String(skill || "").trim();
    if (!key) return fallback;
    if (!Object.prototype.hasOwnProperty.call(this.scores, key)) return fallback;
    return Number(this.scores[key]);
  }

  update(skill, status) {
    const key = String(skill || "").trim();
    if (!key) return null;
    const prev = this.get(key, 0.5);
    const target = String(status || "") === "success" ? 1 : 0;
    const next = prev + this.alpha * (target - prev);
    this.scores[key] = Number(Math.max(0, Math.min(1, next)).toFixed(6));
    return this.scores[key];
  }

  snapshot() {
    return { ...this.scores };
  }
}

module.exports = { SkillConfidence };

