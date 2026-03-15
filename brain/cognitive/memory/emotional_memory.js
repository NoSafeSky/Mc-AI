const { appendJsonlBounded, readJsonl } = require("./memory_store");

class EmotionalMemory {
  constructor(filePath, maxRecords = 500) {
    this.filePath = filePath;
    this.maxRecords = Math.max(50, Number(maxRecords || 500));
  }

  append(entry = {}) {
    const row = {
      ts: Date.now(),
      username: String(entry.username || "unknown"),
      sentiment: Number(entry.sentiment || 0),
      text: String(entry.text || ""),
      mood: String(entry.mood || "content")
    };
    appendJsonlBounded(this.filePath, row, this.maxRecords);
    return row;
  }

  recent(limit = 30) {
    return readJsonl(this.filePath, []).slice(-Math.max(1, Number(limit || 1)));
  }
}

module.exports = { EmotionalMemory };

