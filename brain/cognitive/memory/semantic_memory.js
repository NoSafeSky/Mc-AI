const { safeReadJson, safeWriteJson } = require("./memory_store");

class SemanticMemory {
  constructor(filePath, maxRecords = 500) {
    this.filePath = filePath;
    this.maxRecords = Math.max(25, Number(maxRecords || 500));
    this.facts = safeReadJson(filePath, {});
  }

  upsert(subject, value, confidence = 0.5) {
    const key = String(subject || "").trim();
    if (!key) return null;
    const prev = this.facts[key] || {};
    const nextConfidence = Number.isFinite(Number(confidence))
      ? Math.max(0, Math.min(1, Number(confidence)))
      : Number(prev.confidence || 0.5);
    this.facts[key] = {
      value,
      confidence: nextConfidence,
      evidence: Number(prev.evidence || 0) + 1,
      lastUsed: Date.now()
    };
    this.prune();
    return this.facts[key];
  }

  get(subject) {
    const key = String(subject || "").trim();
    const found = this.facts[key] || null;
    if (found) found.lastUsed = Date.now();
    return found;
  }

  prune() {
    const entries = Object.entries(this.facts)
      .sort((a, b) => Number(b[1]?.lastUsed || 0) - Number(a[1]?.lastUsed || 0));
    if (entries.length <= this.maxRecords) return;
    this.facts = Object.fromEntries(entries.slice(0, this.maxRecords));
  }

  save() {
    safeWriteJson(this.filePath, this.facts);
  }
}

module.exports = { SemanticMemory };

