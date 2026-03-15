function sentimentScore(text) {
  const t = String(text || "").toLowerCase();
  let score = 0;
  if (/\b(thanks|good|nice|great|awesome|perfect)\b/.test(t)) score += 1;
  if (/\b(bad|wrong|stupid|slow|broken|fail|why)\b/.test(t)) score -= 1;
  return score;
}

class SocialTracker {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.players = new Map();
    this.ownerSentimentSamples = [];
  }

  touchPlayer(username) {
    const name = String(username || "").trim();
    if (!name) return null;
    if (!this.players.has(name)) {
      this.players.set(name, {
        username: name,
        chats: 0,
        lastSeenAt: 0,
        lastChatAt: 0
      });
    }
    return this.players.get(name);
  }

  onChat(username, text, isOwner = false) {
    const rec = this.touchPlayer(username);
    if (!rec) return;
    rec.chats += 1;
    rec.lastSeenAt = Date.now();
    rec.lastChatAt = Date.now();
    if (isOwner) {
      const score = sentimentScore(text);
      this.ownerSentimentSamples.push({ ts: Date.now(), score });
      while (this.ownerSentimentSamples.length > 200) this.ownerSentimentSamples.shift();
    }
  }

  onEntityEvent(type, entity) {
    const eventType = String(type || "");
    if (!/player/i.test(eventType) && String(entity?.type || "").toLowerCase() !== "player") return;
    const username = String(entity?.username || entity?.name || "").trim();
    if (!username) return;
    const rec = this.touchPlayer(username);
    if (!rec) return;
    rec.lastSeenAt = Date.now();
  }

  ownerMoodSignal() {
    if (!this.ownerSentimentSamples.length) return 0;
    const recent = this.ownerSentimentSamples.slice(-20);
    const total = recent.reduce((sum, it) => sum + Number(it.score || 0), 0);
    return Number((total / Math.max(1, recent.length)).toFixed(2));
  }

  getSummary() {
    const topPlayers = [...this.players.values()]
      .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
      .slice(0, 10)
      .map((p) => ({
        username: p.username,
        chats: p.chats,
        lastSeenAt: p.lastSeenAt
      }));
    return {
      playersTracked: this.players.size,
      topPlayers,
      ownerMoodSignal: this.ownerMoodSignal()
    };
  }
}

module.exports = { SocialTracker, sentimentScore };

