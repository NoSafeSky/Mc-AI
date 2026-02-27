const { normalizeItemName } = require("./knowledge");

const RUN_PHASES = [
  "bootstrap",
  "stone_age",
  "iron_age",
  "diamond_prep",
  "nether_entry",
  "blaze_phase",
  "pearl_phase",
  "stronghold_search",
  "end_prep",
  "dragon_fight",
  "complete"
];

const PHASE_REQUIREMENTS = {
  bootstrap: [
    { item: "wooden_pickaxe", count: 1 },
    { item: "crafting_table", count: 1 },
    { item: "planks", count: 8 },
    { item: "stick", count: 4 }
  ],
  stone_age: [
    { item: "stone_pickaxe", count: 1 },
    { item: "stone_sword", count: 1 },
    { item: "furnace", count: 1 }
  ],
  iron_age: [
    { item: "iron_pickaxe", count: 1 },
    { item: "bucket", count: 1 },
    { item: "shield", count: 1 }
  ],
  diamond_prep: [
    { item: "diamond_pickaxe", count: 1 },
    { item: "obsidian", count: 10 }
  ],
  nether_entry: [
    { item: "flint_and_steel", count: 1 }
  ],
  blaze_phase: [
    { item: "blaze_rod", count: 6 }
  ],
  pearl_phase: [
    { item: "ender_pearl", count: 12 }
  ],
  stronghold_search: [
    { item: "eye_of_ender", count: 12 }
  ],
  end_prep: [
    { item: "bow", count: 1 },
    { item: "arrow", count: 32 }
  ],
  dragon_fight: [],
  complete: []
};

function inventoryCount(snapshot, itemName) {
  const key = normalizeItemName(itemName);
  if (!key) return 0;
  const inv = snapshot?.inventory || {};
  if (key === "planks") {
    return Object.entries(inv)
      .filter(([name]) => /_planks$/.test(name) || name === "planks")
      .reduce((a, [, c]) => a + Number(c || 0), 0);
  }
  return Number(inv[key] || 0);
}

function phaseRequirements(phase) {
  return Array.isArray(PHASE_REQUIREMENTS[phase]) ? PHASE_REQUIREMENTS[phase] : [];
}

function phaseNeeds(phase, snapshot) {
  const reqs = phaseRequirements(phase);
  const missing = [];
  for (const req of reqs) {
    const have = inventoryCount(snapshot, req.item);
    if (have < req.count) {
      missing.push({ item: req.item, count: req.count - have, required: req.count, have });
    }
  }
  return missing;
}

function nextPhase(phase) {
  const idx = RUN_PHASES.indexOf(phase);
  if (idx < 0) return RUN_PHASES[0];
  return RUN_PHASES[Math.min(idx + 1, RUN_PHASES.length - 1)];
}

function isPhaseComplete(phase, snapshot) {
  if (phase === "dragon_fight") return false;
  if (phase === "complete") return true;
  return phaseNeeds(phase, snapshot).length === 0;
}

function selectCraftTarget(phase, missing) {
  if (!missing.length) return null;
  const ordered = [...missing].sort((a, b) => a.count - b.count);
  for (const miss of ordered) {
    if (miss.item === "obsidian" || miss.item === "blaze_rod" || miss.item === "ender_pearl" || miss.item === "arrow") {
      continue;
    }
    return miss;
  }
  return null;
}

function proposePhaseStep(phase, snapshot, cfg = {}) {
  const missing = phaseNeeds(phase, snapshot);
  if (!missing.length) return null;

  const craftable = selectCraftTarget(phase, missing);
  if (craftable) {
    return {
      id: `phase_${phase}_craft_${craftable.item}`,
      phase,
      action: "craftItem",
      args: { item: craftable.item, count: Math.max(1, craftable.count) },
      successPredicate: `inventory has ${craftable.item}`,
      timeoutMs: Math.max(30_000, Number(cfg.taskTimeoutSec || 60) * 1000),
      retryPolicy: {}
    };
  }

  if (phase === "blaze_phase") {
    return {
      id: "phase_blaze_hunt",
      phase,
      action: "attackMob",
      args: { mobType: "blaze" },
      successPredicate: "blaze rod count increased",
      timeoutMs: 90_000,
      retryPolicy: {}
    };
  }
  if (phase === "pearl_phase") {
    return {
      id: "phase_pearl_hunt",
      phase,
      action: "attackMob",
      args: { mobType: "enderman" },
      successPredicate: "ender pearl count increased",
      timeoutMs: 90_000,
      retryPolicy: {}
    };
  }
  if (phase === "stronghold_search") {
    return {
      id: "phase_stronghold_search",
      phase,
      action: "explore",
      args: { radius: cfg.maxExploreRadius || 500, seconds: 90 },
      successPredicate: "owner confirms stronghold or eye usage",
      timeoutMs: 90_000,
      retryPolicy: {}
    };
  }
  if (phase === "dragon_fight") {
    return {
      id: "phase_dragon_fight",
      phase,
      action: "attackHostile",
      args: {},
      successPredicate: "dragon defeated",
      timeoutMs: 120_000,
      retryPolicy: {}
    };
  }

  return {
    id: `phase_${phase}_explore`,
    phase,
    action: "explore",
    args: { radius: cfg.maxExploreRadius || 500, seconds: 60 },
    successPredicate: `find resources for ${phase}`,
    timeoutMs: 60_000,
    retryPolicy: {}
  };
}

function phaseLabel(phase) {
  return String(phase || "bootstrap").replace(/_/g, " ");
}

function summarizeNeeds(needs, limit = 4) {
  const list = Array.isArray(needs) ? needs : [];
  if (!list.length) return "none";
  return list
    .slice(0, Math.max(1, Number(limit || 4)))
    .map((n) => `${n.item} x${n.count}`)
    .join(", ");
}

function recommendationFromNeed(phase, need, cfg = {}) {
  if (!need?.item) return null;
  const item = normalizeItemName(need.item);
  const count = Math.max(1, Number(need.count || 1));

  if (item === "blaze_rod") {
    return {
      intent: { type: "attackMob", mobType: "blaze", source: "rules", confidence: 0.92 },
      summary: "hunt blazes",
      reason: "need blaze rods for Eyes of Ender",
      source: "rules"
    };
  }
  if (item === "ender_pearl") {
    return {
      intent: { type: "attackMob", mobType: "enderman", source: "rules", confidence: 0.9 },
      summary: "hunt endermen",
      reason: "need ender pearls for Eyes of Ender",
      source: "rules"
    };
  }
  if (item === "obsidian") {
    return {
      intent: {
        type: "explore",
        radius: Math.max(64, Number(cfg.maxExploreRadius || 500)),
        seconds: 60,
        source: "rules",
        confidence: 0.88
      },
      summary: "search exposed lava/obsidian area",
      reason: "need obsidian for nether progression",
      source: "rules"
    };
  }
  if (item === "arrow") {
    return {
      intent: { type: "craftItem", item: "arrow", count, source: "rules", confidence: 0.9 },
      summary: `craft arrows x${count}`,
      reason: "need arrows for end prep and dragon fight",
      source: "rules"
    };
  }

  return {
    intent: { type: "craftItem", item, count, source: "rules", confidence: 0.9 },
    summary: `craft ${item} x${count}`,
    reason: `missing ${item} for phase ${phase}`,
    source: "rules"
  };
}

function proposePhaseRecommendation(phase, snapshot, cfg = {}) {
  const missing = phaseNeeds(phase, snapshot);
  if (!missing.length) {
    if (phase === "dragon_fight") {
      return {
        intent: { type: "attackHostile", source: "rules", confidence: 0.85 },
        summary: "engage hostile threats in End",
        reason: "dragon phase combat support",
        source: "rules"
      };
    }
    return null;
  }
  const sorted = [...missing].sort((a, b) => a.count - b.count || String(a.item).localeCompare(String(b.item)));
  for (const need of sorted) {
    const rec = recommendationFromNeed(phase, need, cfg);
    if (rec) return rec;
  }
  return null;
}

module.exports = {
  RUN_PHASES,
  phaseRequirements,
  phaseNeeds,
  nextPhase,
  isPhaseComplete,
  proposePhaseRecommendation,
  summarizeNeeds,
  proposePhaseStep,
  phaseLabel
};
