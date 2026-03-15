const { moodPromptPrefix } = require("./personality_traits");

const MOODS = ["content", "excited", "cautious", "anxious", "frustrated"];

function normalizeMood(value) {
  const m = String(value || "content");
  return MOODS.includes(m) ? m : "content";
}

class MoodEngine {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.state = {
      mood: "content",
      lastChangedAt: Date.now(),
      score: 0
    };
  }

  setMood(nextMood) {
    const mood = normalizeMood(nextMood);
    if (this.state.mood === mood) return;
    this.state.mood = mood;
    this.state.lastChangedAt = Date.now();
  }

  onTaskOutcome(status) {
    const s = String(status || "");
    if (s === "success") {
      this.state.score = Math.min(3, this.state.score + 1);
    } else if (s === "fail" || s === "timeout") {
      this.state.score = Math.max(-3, this.state.score - 1);
    }
    if (this.state.score >= 2) this.setMood("excited");
    else if (this.state.score <= -3) this.setMood("frustrated");
    else if (this.state.score <= -2) this.setMood("anxious");
    else if (this.state.score <= -1) this.setMood("cautious");
    else this.setMood("content");
  }

  onOwnerSentiment(sentiment) {
    const n = Number(sentiment || 0);
    if (n < -0.4) this.setMood("cautious");
    if (n > 0.4 && this.state.mood !== "frustrated") this.setMood("content");
  }

  decay() {
    const decayMs = Math.max(60000, Number(this.cfg?.cognitive?.mood?.decayToContentMs || 300000));
    if (Date.now() - Number(this.state.lastChangedAt || 0) < decayMs) return;
    this.state.score = 0;
    this.setMood("content");
  }

  personalityModifier() {
    this.decay();
    return moodPromptPrefix(this.state.mood);
  }

  getState() {
    this.decay();
    return { ...this.state };
  }
}

module.exports = { MoodEngine, MOODS };

