function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function roundCoord(value) {
  if (!isFiniteNumber(value)) return 0;
  return Number(Number(value).toFixed(2));
}

function positionSnapshot(pos) {
  if (!pos) return null;
  return {
    x: roundCoord(pos.x),
    y: roundCoord(pos.y),
    z: roundCoord(pos.z)
  };
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function ownerDistance(bot, ownerName) {
  const owner = bot?.players?.[ownerName]?.entity;
  const selfPos = bot?.entity?.position;
  if (!owner?.position || !selfPos?.distanceTo) return null;
  const dist = selfPos.distanceTo(owner.position);
  if (!isFiniteNumber(dist)) return null;
  return Number(dist.toFixed(2));
}

function hostileCount(bot) {
  const entities = Object.values(bot?.entities || {});
  let count = 0;
  for (const entity of entities) {
    const name = String(entity?.name || entity?.displayName || "").toLowerCase();
    if (!name) continue;
    if (/(zombie|skeleton|creeper|spider|witch|drowned|enderman|pillager|vindicator|ravager|slime|phantom|hoglin|piglin_brute)/.test(name)) {
      count += 1;
    }
  }
  return count;
}

class WorldModel {
  constructor(bot, cfg = {}) {
    this.bot = bot;
    this.cfg = cfg;
    this.snapshot = {
      self: {},
      environment: {},
      social: {},
      temporal: {},
      updatedAt: 0
    };
  }

  update(sectionName, nextValue) {
    const section = String(sectionName || "");
    if (!section) return { changed: false, changes: [] };
    const current = this.snapshot[section] || {};
    const changes = [];
    const merged = { ...current };
    for (const [key, value] of Object.entries(nextValue || {})) {
      if (!sameValue(current[key], value)) {
        merged[key] = value;
        changes.push(key);
      }
    }
    if (!changes.length) return { changed: false, changes: [] };
    this.snapshot[section] = merged;
    this.snapshot.updatedAt = Date.now();
    return { changed: true, changes };
  }

  applyFastTick() {
    const bot = this.bot;
    const own = this.cfg.owner || "";
    const selfUpdate = {
      health: Number(bot?.health || 0),
      food: Number(bot?.food || 0),
      position: positionSnapshot(bot?.entity?.position),
      ownerDistance: ownerDistance(bot, own),
      nearbyHostiles: hostileCount(bot)
    };
    return {
      self: this.update("self", selfUpdate)
    };
  }

  applyMediumTick() {
    const bot = this.bot;
    const envUpdate = {
      biome: String(bot?.biome?.name || ""),
      timeOfDay: Number(bot?.time?.timeOfDay || 0),
      isDay: !!bot?.time?.isDay,
      isRaining: !!bot?.isRaining,
      inventoryCount: Array.isArray(bot?.inventory?.items?.()) ? bot.inventory.items().length : 0
    };
    return {
      environment: this.update("environment", envUpdate)
    };
  }

  applySlowTick(socialSummary = {}) {
    const temporalUpdate = {
      worldAge: Number(this.bot?.time?.age || 0),
      lastSlowTickAt: Date.now()
    };
    return {
      social: this.update("social", socialSummary || {}),
      temporal: this.update("temporal", temporalUpdate)
    };
  }

  getSnapshot() {
    return JSON.parse(JSON.stringify(this.snapshot));
  }
}

module.exports = { WorldModel };

