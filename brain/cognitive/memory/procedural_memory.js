const { safeReadJson, safeWriteJson } = require("./memory_store");

class ProceduralMemory {
  constructor(filePath, maxRecords = 200) {
    this.filePath = filePath;
    this.maxRecords = Math.max(25, Number(maxRecords || 200));
    this.rows = safeReadJson(filePath, {});
  }

  record(skill, status, context = {}) {
    const key = String(skill || "").trim();
    if (!key) return null;
    const row = this.rows[key] || {
      success: 0,
      fail: 0,
      timeout: 0,
      cancel: 0,
      sampleSize: 0,
      successRate: 0,
      lastOutcome: null,
      lastUpdated: 0,
      context: {}
    };
    const normalized = String(status || "fail");
    if (normalized === "success") row.success += 1;
    else if (normalized === "timeout") row.timeout += 1;
    else if (normalized === "cancel") row.cancel += 1;
    else row.fail += 1;
    row.sampleSize += 1;
    row.successRate = Number((row.success / Math.max(1, row.sampleSize)).toFixed(4));
    row.lastOutcome = normalized;
    row.lastUpdated = Date.now();
    row.context = context || {};
    this.rows[key] = row;
    this.prune();
    return row;
  }

  prune() {
    const entries = Object.entries(this.rows)
      .sort((a, b) => Number(b[1]?.lastUpdated || 0) - Number(a[1]?.lastUpdated || 0));
    if (entries.length <= this.maxRecords) return;
    this.rows = Object.fromEntries(entries.slice(0, this.maxRecords));
  }

  save() {
    safeWriteJson(this.filePath, this.rows);
  }
}

module.exports = { ProceduralMemory };

