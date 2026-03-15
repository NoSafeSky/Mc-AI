const path = require("path");
const { EventBus } = require("./event_bus");
const { WorldModel } = require("./awareness/world_model");
const { PerceptionEngine } = require("./awareness/perception_engine");
const { SocialTracker } = require("./awareness/social_tracker");
const { MemoryManager } = require("./memory/memory_manager");
const { SkillConfidence } = require("./learning/skill_confidence");
const { OutcomeTracker } = require("./learning/outcome_tracker");
const { PreferenceLearner } = require("./learning/preference_learner");
const { MoodEngine } = require("./personality/mood_engine");
const { InitiativeEngine } = require("./personality/initiative_engine");
const { Monologue } = require("./personality/monologue");
const { AutonomyManager } = require("./trust/autonomy_manager");
const { classifyIntentRisk } = require("./trust/risk_assessor");

function defaultCognitiveConfig(existing = {}) {
  const cognitive = existing?.cognitive || {};
  return {
    cognitiveEnabled: existing.cognitiveEnabled === true || cognitive.enabled === true,
    cognitive: {
      enabled: cognitive.enabled === true || existing.cognitiveEnabled === true,
      ticks: {
        fastMs: Number(cognitive?.ticks?.fastMs || 2000),
        mediumMs: Number(cognitive?.ticks?.mediumMs || 10000),
        slowMs: Number(cognitive?.ticks?.slowMs || 60000)
      },
      initiative: {
        enabled: cognitive?.initiative?.enabled !== false,
        cooldownMs: Number(cognitive?.initiative?.cooldownMs || 90000),
        maxCommentsPer10Min: Number(cognitive?.initiative?.maxCommentsPer10Min || 5)
      },
      mood: {
        enabled: cognitive?.mood?.enabled !== false,
        decayToContentMs: Number(cognitive?.mood?.decayToContentMs || 300000)
      },
      memory: {
        episodicMax: Number(cognitive?.memory?.episodicMax || 2000),
        semanticMax: Number(cognitive?.memory?.semanticMax || 500),
        proceduralMax: Number(cognitive?.memory?.proceduralMax || 200),
        emotionalMax: Number(cognitive?.memory?.emotionalMax || 500)
      },
      llmBudget: {
        monologueEnabled: cognitive?.llmBudget?.monologueEnabled === true,
        monologueMaxPer5Min: Number(cognitive?.llmBudget?.monologueMaxPer5Min || 3),
        recallEnabled: cognitive?.llmBudget?.recallEnabled === true,
        recallMaxPerMin: Number(cognitive?.llmBudget?.recallMaxPerMin || 1),
        timeoutMs: Number(cognitive?.llmBudget?.timeoutMs || 2000)
      },
      trust: {
        enabled: cognitive?.trust?.enabled !== false,
        start: Number(cognitive?.trust?.start ?? 0.1),
        successDelta: Number(cognitive?.trust?.successDelta ?? 0.02),
        failDelta: Number(cognitive?.trust?.failDelta ?? -0.05)
      },
      autonomyPolicy: {
        advisoryOnly: cognitive?.autonomyPolicy?.advisoryOnly !== false
      }
    }
  };
}

class CognitiveCore {
  constructor(bot, cfg = {}, services = {}) {
    this.bot = bot;
    this.cfg = cfg;
    this.log = typeof services.log === "function" ? services.log : () => {};
    this.sendAdvisory = typeof services.sendAdvisory === "function" ? services.sendAdvisory : () => {};
    this.isBusy = typeof services.isBusy === "function" ? services.isBusy : () => false;
    this.owner = String(services.owner || cfg.owner || "");
    this.enabled = cfg?.cognitiveEnabled === true || cfg?.cognitive?.enabled === true;

    const memoryDir = String(services.memoryDir || path.join(process.cwd(), "memory", "cognitive"));
    this.eventBus = new EventBus();
    this.worldModel = new WorldModel(bot, cfg);
    this.socialTracker = new SocialTracker(cfg);
    this.memory = new MemoryManager(memoryDir, cfg, this.log);
    this.skillConfidence = new SkillConfidence(this.memory.getPreference("skillConfidence", {}));
    this.outcomeTracker = new OutcomeTracker(this.memory, this.skillConfidence, this.log);
    this.preferenceLearner = new PreferenceLearner(this.memory);
    this.moodEngine = new MoodEngine(cfg);
    this.initiativeEngine = new InitiativeEngine(bot, cfg, this.log);
    this.monologue = new Monologue(cfg);
    this.autonomyManager = new AutonomyManager(cfg, this.memory.loadTrustState());
    this.perception = new PerceptionEngine({
      worldModel: this.worldModel,
      socialTracker: this.socialTracker,
      eventBus: this.eventBus,
      log: this.log,
      cfg
    });
    this.boundSlowTick = () => this.handleSlowTick();
    this.eventBus.on("perception:slow", this.boundSlowTick);
  }

  start() {
    if (!this.enabled) return;
    this.perception.start();
    this.log({ type: "cognitive_start" });
  }

  stop() {
    if (!this.enabled) return;
    this.perception.stop();
    this.memory.saveAll();
    this.memory.saveTrustState({
      ...this.autonomyManager.getState(),
      skillConfidence: this.skillConfidence.snapshot(),
      moodBaseline: this.moodEngine.getState().mood
    });
    this.log({ type: "cognitive_stop" });
  }

  handleSlowTick() {
    if (!this.enabled) return;
    this.memory.applyDecay();
    this.memory.saveAll();
    this.memory.saveTrustState({
      ...this.autonomyManager.getState(),
      skillConfidence: this.skillConfidence.snapshot(),
      moodBaseline: this.moodEngine.getState().mood
    });
    if (this.isBusy()) return;
    const suggestion = this.initiativeEngine.evaluate(this.worldModel.getSnapshot(), classifyIntentRisk);
    if (!suggestion) return;
    const needsConfirm = suggestion.risk === "medium" || suggestion.risk === "high";
    const suffix = needsConfirm ? " Say yes if you want that." : "";
    this.sendAdvisory(`${suggestion.message}${suffix}`, suggestion);
    this.memory.recordEpisode({
      type: "initiative_suggestion",
      tags: ["initiative", suggestion.rule, suggestion.risk],
      importance: 0.4,
      context: suggestion,
      outcome: { status: "suggested" }
    });
    this.log({
      type: "cognitive_initiative",
      rule: suggestion.rule,
      risk: suggestion.risk
    });
  }

  onChat(username, text, isOwner = false) {
    if (!this.enabled) return;
    this.socialTracker.onChat(username, text, isOwner);
    if (isOwner) {
      this.preferenceLearner.observeOwnerChat(text);
    }
    const sentiment = this.socialTracker.ownerMoodSignal();
    this.moodEngine.onOwnerSentiment(sentiment);
    this.memory.recordEmotion({
      username,
      text,
      sentiment,
      mood: this.moodEngine.getState().mood
    });
  }

  onEntityEvent(type, entity) {
    if (!this.enabled) return;
    this.socialTracker.onEntityEvent(type, entity);
    this.memory.working.add({
      kind: "entity_event",
      eventType: String(type || ""),
      entityId: entity?.id || null,
      entityName: entity?.name || entity?.username || null
    });
  }

  async wrapExecution(intent, isOwner, executeFn, context = {}) {
    if (!this.enabled) return executeFn();
    const risk = classifyIntentRisk(intent);
    const confidence = this.skillConfidence.get(String(intent?.type || "unknown"), 0.5);
    const mood = this.moodEngine.getState().mood;
    const thought = this.monologue.create(intent, confidence, mood);
    if (thought) {
      this.log({
        type: "cognitive_monologue",
        intentType: intent?.type || "unknown",
        thought
      });
    }
    let result = null;
    try {
      result = await executeFn();
      return result;
    } finally {
      const finalResult = result || { status: "fail", reason: "unknown result", code: "unknown_result" };
      this.outcomeTracker.record({
        intent,
        result: finalResult,
        isOwner,
        context: {
          taskId: context?.taskId || null,
          risk
        }
      });
      this.moodEngine.onTaskOutcome(finalResult.status);
      this.autonomyManager.updateFromTaskResult(finalResult);
      this.preferenceLearner.observeTaskAcceptance(intent);
      this.memory.setPreference("skillConfidence", this.skillConfidence.snapshot());
      this.memory.saveTrustState({
        ...this.autonomyManager.getState(),
        skillConfidence: this.skillConfidence.snapshot(),
        moodBaseline: this.moodEngine.getState().mood
      });
    }
  }

  getPersonalityModifier() {
    if (!this.enabled || this.cfg?.cognitive?.mood?.enabled === false) return null;
    return this.moodEngine.personalityModifier();
  }

  getRouteContext() {
    return {
      personalityModifier: this.getPersonalityModifier()
    };
  }

  getState() {
    return {
      enabled: this.enabled,
      mood: this.moodEngine.getState(),
      trust: this.autonomyManager.getState(),
      preferences: this.preferenceLearner.snapshot(),
      world: this.worldModel.getSnapshot()
    };
  }
}

function createCognitiveCore(bot, cfg = {}, services = {}) {
  const merged = {
    ...cfg,
    ...defaultCognitiveConfig(cfg)
  };
  return new CognitiveCore(bot, merged, services);
}

module.exports = {
  CognitiveCore,
  createCognitiveCore,
  defaultCognitiveConfig
};
