const { appendJsonlBounded, readJsonl } = require("./memory_store");

class EpisodicMemory {
  constructor(filePath, maxRecords = 2000) {
    this.filePath = filePath;
    this.maxRecords = Math.max(50, Number(maxRecords || 2000));
  }

  append(entry = {}) {
    const row = {
      ts: Date.now(),
      type: String(entry.type || "episode"),
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      importance: Number(entry.importance || 0),
      context: entry.context || {},
      outcome: entry.outcome || {}
    };
    appendJsonlBounded(this.filePath, row, this.maxRecords);
    return row;
  }

  list() {
    return readJsonl(this.filePath, []);
  }

  searchByTags(tags = [], options = {}) {
    const required = new Set((tags || []).map((t) => String(t || "").trim()).filter(Boolean));
    const minImportance = Number(options.minImportance || 0);
    const rows = this.list();
    return rows
      .filter((row) => Number(row.importance || 0) >= minImportance)
      .filter((row) => {
        if (!required.size) return true;
        const rowTags = new Set((row.tags || []).map((t) => String(t || "").trim()));
        for (const tag of required) {
          if (!rowTags.has(tag)) return false;
        }
        return true;
      })
      .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  }
}

module.exports = { EpisodicMemory };

