function countItem(bot, name) {
  const target = String(name || "").toLowerCase();
  const items = bot?.inventory?.items?.() || [];
  return items
    .filter((it) => String(it?.name || "").toLowerCase() === target)
    .reduce((sum, it) => sum + Number(it?.count || 0), 0);
}

class InitiativeEngine {
  constructor(bot, cfg = {}, log = () => {}) {
    this.bot = bot;
    this.cfg = cfg;
    this.log = typeof log === "function" ? log : () => {};
    this.lastCommentAt = 0;
    this.commentHistory = [];
  }

  shouldSpeak() {
    const initCfg = this.cfg?.cognitive?.initiative || {};
    if (initCfg.enabled === false) return false;
    const now = Date.now();
    const cooldownMs = Math.max(10000, Number(initCfg.cooldownMs || 90000));
    const maxPerWindow = Math.max(1, Number(initCfg.maxCommentsPer10Min || 5));
    this.commentHistory = this.commentHistory.filter((ts) => (now - ts) <= 600000);
    if (now - this.lastCommentAt < cooldownMs) return false;
    if (this.commentHistory.length >= maxPerWindow) return false;
    return true;
  }

  markSpoken() {
    const now = Date.now();
    this.lastCommentAt = now;
    this.commentHistory.push(now);
  }

  evaluate(snapshot = {}, riskAssessor) {
    if (!this.shouldSpeak()) return null;
    const self = snapshot?.self || {};
    const env = snapshot?.environment || {};
    const hostiles = Number(self.nearbyHostiles || 0);
    const health = Number(self.health || 20);
    const food = Number(self.food || 20);
    const isNight = !env.isDay;
    const torches = countItem(this.bot, "torch");

    if (hostiles > 0 && health <= 10) {
      this.markSpoken();
      return {
        message: "I see nearby hostiles and low health. Want me to regroup to safety?",
        risk: "medium",
        rule: "hostile_low_health"
      };
    }
    if (food <= 6) {
      this.markSpoken();
      return {
        message: "Food is low. Want me to gather food next?",
        risk: "low",
        rule: "low_food"
      };
    }
    if (isNight && torches < 4) {
      this.markSpoken();
      return {
        message: "It is dark and torches are low. Want me to craft more torches?",
        risk: "low",
        rule: "dark_low_torches"
      };
    }
    if (riskAssessor && hostiles > 2) {
      this.markSpoken();
      return {
        message: "Area looks risky right now. Want me to stay close and avoid combat?",
        risk: "medium",
        rule: "hostile_cluster"
      };
    }
    return null;
  }
}

module.exports = { InitiativeEngine };

