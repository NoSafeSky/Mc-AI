const path = require("path");
const { ensureDir, safeReadJson, safeWriteJson, writeJsonl } = require("./memory_store");
const { WorkingMemory } = require("./working_memory");
const { EpisodicMemory } = require("./episodic_memory");
const { SemanticMemory } = require("./semantic_memory");
const { ProceduralMemory } = require("./procedural_memory");
const { EmotionalMemory } = require("./emotional_memory");
const { pruneByImportance } = require("./memory_decay");

class MemoryManager {
  constructor(baseDir, cfg = {}, log = () => {}) {
    this.baseDir = baseDir;
    this.cfg = cfg;
    this.log = typeof log === "function" ? log : () => {};
    const memCfg = cfg?.cognitive?.memory || {};
    ensureDir(baseDir);
    this.paths = {
      episodic: path.join(baseDir, "episodic.jsonl"),
      semantic: path.join(baseDir, "semantic.json"),
      procedural: path.join(baseDir, "procedural.json"),
      emotional: path.join(baseDir, "emotional.jsonl"),
      preferences: path.join(baseDir, "preferences.json"),
      trust: path.join(baseDir, "trust.json")
    };
    this.working = new WorkingMemory({ maxEntries: 300, maxAgeMs: 300000 });
    this.episodic = new EpisodicMemory(this.paths.episodic, Number(memCfg.episodicMax || 2000));
    this.semantic = new SemanticMemory(this.paths.semantic, Number(memCfg.semanticMax || 500));
    this.procedural = new ProceduralMemory(this.paths.procedural, Number(memCfg.proceduralMax || 200));
    this.emotional = new EmotionalMemory(this.paths.emotional, Number(memCfg.emotionalMax || 500));
    this.preferences = safeReadJson(this.paths.preferences, {});
    this.lastRecallAt = 0;
  }

  recordEpisode(entry = {}) {
    this.working.add({ kind: "episode", ...entry });
    return this.episodic.append(entry);
  }

  recordEmotion(entry = {}) {
    this.working.add({ kind: "emotion", ...entry });
    return this.emotional.append(entry);
  }

  upsertSemantic(subject, value, confidence = 0.5) {
    return this.semantic.upsert(subject, value, confidence);
  }

  updateProcedural(skill, status, context = {}) {
    return this.procedural.record(skill, status, context);
  }

  setPreference(key, value) {
    const k = String(key || "").trim();
    if (!k) return;
    this.preferences[k] = value;
  }

  getPreference(key, fallback = null) {
    const k = String(key || "").trim();
    if (!k) return fallback;
    return Object.prototype.hasOwnProperty.call(this.preferences, k) ? this.preferences[k] : fallback;
  }

  searchEpisodesByTags(tags = [], options = {}) {
    return this.episodic.searchByTags(tags, options);
  }

  async recall(query = {}, options = {}) {
    const tags = Array.isArray(query.tags) ? query.tags : [];
    const minImportance = Number(query.minImportance || 0);
    const deterministic = this.searchEpisodesByTags(tags, { minImportance }).slice(0, 10);
    if (deterministic.length > 0) return { source: "deterministic", rows: deterministic };

    const llmBudget = this.cfg?.cognitive?.llmBudget || {};
    if (llmBudget.recallEnabled !== true) return { source: "deterministic", rows: [] };
    const now = Date.now();
    const minIntervalMs = Math.max(1000, Math.floor(60000 / Math.max(1, Number(llmBudget.recallMaxPerMin || 1))));
    if ((now - this.lastRecallAt) < minIntervalMs) return { source: "deterministic", rows: [] };
    const fallback = typeof options.fallbackFn === "function" ? options.fallbackFn : null;
    if (!fallback) return { source: "deterministic", rows: [] };
    this.lastRecallAt = now;
    try {
      const rows = await fallback({ query, deterministic }, {
        timeoutMs: Number(llmBudget.timeoutMs || 2000)
      });
      return { source: "fallback", rows: Array.isArray(rows) ? rows : [] };
    } catch {
      return { source: "fallback", rows: [] };
    }
  }

  applyDecay() {
    const rows = this.episodic.list();
    const maxRecords = Number(this.cfg?.cognitive?.memory?.episodicMax || 2000);
    const pruned = pruneByImportance(rows, {
      maxRecords,
      minImportance: 0.15
    });
    writeJsonl(this.paths.episodic, pruned);
    this.log({
      type: "cognitive_memory_decay",
      before: rows.length,
      after: pruned.length
    });
  }

  saveTrustState(trustState = {}) {
    safeWriteJson(this.paths.trust, trustState || {});
  }

  loadTrustState() {
    return safeReadJson(this.paths.trust, {});
  }

  saveAll() {
    this.semantic.save();
    this.procedural.save();
    safeWriteJson(this.paths.preferences, this.preferences || {});
  }
}

module.exports = { MemoryManager };
