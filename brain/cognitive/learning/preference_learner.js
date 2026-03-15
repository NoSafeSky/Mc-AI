function normalizeKey(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

class PreferenceLearner {
  constructor(memoryManager) {
    this.memory = memoryManager;
    this.cache = this.memory?.getPreference("ownerPreferences", {}) || {};
  }

  observeOwnerChat(text) {
    const t = normalizeKey(text);
    if (!t) return;
    if (/dont use bamboo|don't use bamboo/.test(t)) {
      this.bump("avoid_bamboo", 1);
    }
    if (/be quick|faster|speed/.test(t)) {
      this.bump("prefer_speed", 1);
    }
    if (/be safe|careful|dont die|don't die/.test(t)) {
      this.bump("prefer_safety", 1);
    }
  }

  observeTaskAcceptance(intent) {
    const type = String(intent?.type || "");
    if (!type) return;
    this.bump(`accepted_${type}`, 1);
  }

  bump(key, amount = 1) {
    const k = String(key || "").trim();
    if (!k) return;
    this.cache[k] = Number(this.cache[k] || 0) + Number(amount || 0);
    this.memory?.setPreference("ownerPreferences", this.cache);
  }

  snapshot() {
    return { ...this.cache };
  }
}

module.exports = { PreferenceLearner };

