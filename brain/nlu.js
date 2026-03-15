const {
  normalizeEntityName,
  isLivingNonPlayerEntity,
  getCanonicalEntityName
} = require("./entities");
const { parseCraftRequest, normalizeCraftItem, resolveDynamicItemName } = require("./crafting_catalog");

const KNOWN_MOBS = new Set([
  "allay", "armadillo", "axolotl", "bat", "bee", "blaze", "bogged", "breeze", "camel", "cat",
  "cave_spider", "chicken", "cod", "cow", "creeper", "dolphin", "donkey", "drowned", "elder_guardian",
  "enderman", "endermite", "evoker", "fox", "frog", "ghast", "glow_squid", "goat", "guardian",
  "hoglin", "horse", "husk", "iron_golem", "llama", "magma_cube", "mooshroom", "mule", "ocelot",
  "panda", "parrot", "phantom", "pig", "piglin", "piglin_brute", "pillager", "polar_bear", "pufferfish",
  "rabbit", "ravager", "salmon", "sheep", "shulker", "silverfish", "skeleton", "skeleton_horse",
  "slime", "sniffer", "snow_golem", "spider", "squid", "stray", "strider", "tadpole", "trader_llama",
  "tropical_fish", "turtle", "vex", "villager", "vindicator", "wandering_trader", "warden", "witch",
  "wither_skeleton", "wolf", "zoglin", "zombie", "zombie_horse", "zombie_villager", "zombified_piglin"
]);

const MOB_ALIASES = new Map([
  ["piggy", "pig"],
  ["piggies", "pig"],
  ["zombi", "zombie"],
  ["zombies", "zombie"],
  ["skeletons", "skeleton"],
  ["creepers", "creeper"],
  ["spiders", "spider"],
  ["cows", "cow"],
  ["sheeps", "sheep"],
  ["sheep", "sheep"],
  ["chickens", "chicken"],
  ["villagers", "villager"],
  ["hostiles", "hostile"],
  ["monster", "hostile"],
  ["monsters", "hostile"]
]);

const COUNT_WORDS = new Map([
  ["a", 1],
  ["an", 1],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12]
]);

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toMobKey(name) {
  return normalizeEntityName(name);
}

function visibleMobs(bot) {
  if (!bot || !bot.entities) return [];
  return Object.values(bot.entities)
    .filter((e) => isLivingNonPlayerEntity(e))
    .map((e) => toMobKey(getCanonicalEntityName(e)))
    .filter(Boolean);
}

function canonicalizeMob(rawMob, bot) {
  if (!rawMob) return null;
  let key = toMobKey(rawMob);
  if (!key) return null;

  if (MOB_ALIASES.has(key)) {
    key = MOB_ALIASES.get(key);
  } else if (key.endsWith("s") && MOB_ALIASES.has(key.slice(0, -1))) {
    key = MOB_ALIASES.get(key.slice(0, -1));
  } else if (key.endsWith("s")) {
    key = key.slice(0, -1);
  }

  const visible = visibleMobs(bot);
  if (visible.includes(key)) return key;

  if (KNOWN_MOBS.has(key)) return key;

  return null;
}

function parseCountToken(raw, fallback = 1) {
  const token = String(raw || "").toLowerCase().trim();
  if (!token) return fallback;
  const numeric = Number.parseInt(token, 10);
  if (Number.isFinite(numeric) && numeric > 0) return Math.max(1, Math.min(64, numeric));
  if (COUNT_WORDS.has(token)) return Math.max(1, Math.min(64, COUNT_WORDS.get(token)));
  return fallback;
}

function parseCombatIntent(t, bot) {
  const attackVerb = /\b(kill|attack|hunt|slay)\b/.exec(t);
  if (!attackVerb) return null;

  const afterVerb = t.slice(attackVerb.index + attackVerb[0].length).trim();
  if (!afterVerb) return { type: "none", source: "rules", confidence: 0, reason: "ambiguous_target" };

  if (/^(it|him|her|them)\b/.test(afterVerb)) {
    return { type: "none", source: "rules", confidence: 0, reason: "ambiguous_target" };
  }

  if (/\b(hostile|hostiles|monster|monsters)\b/.test(afterVerb)) {
    return { type: "attackHostile", source: "rules", confidence: 0.93 };
  }

  if (/\b(food|animals|animal)\b/.test(afterVerb)) {
    return { type: "huntFood", source: "rules", confidence: 0.88 };
  }

  const mobMatch = /^(?:(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+)?(?:a|an|the)?\s*([a-z_]+(?:\s+[a-z_]+)?)\b/.exec(afterVerb);
  if (!mobMatch) return { type: "none", source: "rules", confidence: 0, reason: "ambiguous_target" };

  const count = parseCountToken(mobMatch[1], 1);
  const mobType = canonicalizeMob(mobMatch[2], bot);
  if (!mobType) return { type: "none", source: "rules", confidence: 0, reason: "unknown_target" };

  return { type: "attackMob", mobType, count, source: "rules", confidence: 0.96 };
}

function parseGiveRequest(t, defaultCount = 1, version = "1.21.1") {
  const giveMatch = /^(?:please\s+)?give\s+me\s+(?:(\d+|a|an)\s+)?(.+)$/.exec(t);
  if (!giveMatch) return { isGivePhrase: false, item: null, count: defaultCount, rawItem: null };
  let rawItem = String(giveMatch[2] || "")
    .replace(/\b(for me|please|now)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const countRaw = giveMatch[1];
  let count = Number.parseInt(countRaw, 10);
  if (!Number.isFinite(count) || count <= 0) {
    count = (countRaw === "a" || countRaw === "an") ? 1 : defaultCount;
  }
  count = Math.max(1, Math.min(64, count));
  const item = normalizeCraftItem(rawItem, version) || resolveDynamicItemName(rawItem, version);
  return {
    isGivePhrase: true,
    item: item || null,
    count,
    rawItem
  };
}

function parseNLU(text, cfg, bot) {
  if (!text) return { type: "none", source: "rules", confidence: 0 };
  const t = normalizeText(text);
  const defaultCraftCount = cfg.craftDefaultCount || 1;

  if (!t) return { type: "none", source: "rules", confidence: 0 };
  if (
    /\bhow\s+(?:do\s+i|to)\s+(?:craft|make)\b/.test(t) ||
    /\bhow\s+can\s+i\s+(?:craft|make)\b/.test(t) ||
    /\brecipe\s+for\b/.test(t) ||
    /\bgive\s+me\s+(?:a\s+)?recipe\s+for\b/.test(t)
  ) {
    return { type: "none", source: "rules", confidence: 0, reason: "recipe_question" };
  }
  if (t === "stopall" || t.includes("stop all") || t.includes("stop everything") || t.includes("!stopall")) {
    return { type: "stopall", source: "rules", confidence: 1 };
  }
  if (
    t === "dropall"
    || /^(drop|toss|throw)\s+all$/.test(t)
    || /^(drop|toss|throw)\s+(?:my\s+|bot'?s\s+|bot\s+|bots\s+)?(?:items?|inventory|inv|stuff|loot)$/.test(t)
    || (
      /\b(drop|toss|throw)\b/.test(t)
      && /\b(all|everything)\b/.test(t)
      && /\b(item|items|inventory|inv|stuff|loot)\b/.test(t)
    )
  ) {
    return { type: "dropAllItems", source: "rules", confidence: 1 };
  }
  if (t === "stop" || t.includes("stop moving") || t.includes("stop following")) {
    return { type: "stop", source: "rules", confidence: 1 };
  }
  if (/\bresume\b/.test(t)) return { type: "resume", source: "rules", confidence: 1 };

  if (t.includes("stalk me") || /\bstalk\b/.test(t)) {
    return { type: "stalk", target: cfg.owner, source: "rules", confidence: 0.97 };
  }
  if (t.includes("follow me") || t.startsWith("follow ")) {
    return { type: "follow", target: cfg.owner, source: "rules", confidence: 0.98 };
  }
  if (t.includes("come here") || t.includes("come to me") || t === "come" || t.startsWith("come ")) {
    return { type: "come", target: cfg.owner, source: "rules", confidence: 0.98 };
  }

  const giveReq = parseGiveRequest(t, defaultCraftCount, bot?.version || cfg.version || "1.21.1");
  if (giveReq.isGivePhrase) {
    if (giveReq.item) {
      return {
        type: "giveItem",
        item: giveReq.item,
        count: giveReq.count || 1,
        source: "rules",
        confidence: 0.92
      };
    }
    return {
      type: "none",
      source: "rules",
      confidence: 0,
      reason: "missing_item",
      requested: giveReq.rawItem || null
    };
  }

  if (t.includes("be creepy") || t.includes("creepy mode") || t.includes("creepy on")) {
    return { type: "setCreepy", value: true, source: "rules", confidence: 0.95 };
  }
  if (t.includes("be normal") || t.includes("normal mode") || t.includes("creepy off")) {
    return { type: "setCreepy", value: false, source: "rules", confidence: 0.95 };
  }

  const craftReq = parseCraftRequest(t, defaultCraftCount, bot?.version || cfg.version || "1.21.1");
  if (craftReq.isCraftPhrase) {
    if (craftReq.item) {
      return {
        type: "craftItem",
        item: craftReq.item,
        count: craftReq.count || defaultCraftCount,
        source: "rules",
        confidence: 0.92
      };
    }
    return {
      type: "none",
      source: "rules",
      confidence: 0,
      reason: "unknown_craft_target",
      requested: craftReq.rawItem || null
    };
  }

  if (/\b(harvest|chop)\b/.test(t)) return { type: "harvest", source: "rules", confidence: 0.9 };
  if (/\bcraft basic\b/.test(t)) {
    return { type: "craftBasic", source: "rules", confidence: 0.88 };
  }
  if (/\b(explore|roam|search|seek village|find village)\b/.test(t)) {
    return { type: "explore", radius: cfg.maxExploreRadius || 500, seconds: 60, source: "rules", confidence: 0.84 };
  }

  const combatIntent = parseCombatIntent(t, bot);
  if (combatIntent) return combatIntent;

  if (/\b(seek|find|explore|craft|build|mine|gather|get|bring|collect)\b/.test(t)) {
    return { type: "freeform", message: t, source: "rules", confidence: 0.74 };
  }

  return { type: "none", source: "rules", confidence: 0 };
}

module.exports = { parseNLU, canonicalizeMob, normalizeText, __test: { parseCountToken } };
