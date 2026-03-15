class WorkingMemory {
  constructor(options = {}) {
    this.maxEntries = Math.max(10, Number(options.maxEntries || 300));
    this.maxAgeMs = Math.max(60000, Number(options.maxAgeMs || 300000));
    this.rows = [];
  }

  add(entry = {}) {
    const row = {
      ts: Date.now(),
      ...entry
    };
    this.rows.push(row);
    this.prune();
    return row;
  }

  prune() {
    const cutoff = Date.now() - this.maxAgeMs;
    this.rows = this.rows.filter((row) => Number(row.ts || 0) >= cutoff);
    if (this.rows.length > this.maxEntries) {
      this.rows = this.rows.slice(this.rows.length - this.maxEntries);
    }
  }

  recent(limit = 50) {
    this.prune();
    const n = Math.max(1, Number(limit || 1));
    return this.rows.slice(-n);
  }
}

module.exports = { WorkingMemory };

