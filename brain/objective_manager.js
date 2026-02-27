const { canonicalInventory } = require("./knowledge");
const {
  RUN_PHASES,
  phaseNeeds,
  nextPhase,
  isPhaseComplete,
  phaseLabel,
  proposePhaseRecommendation,
  summarizeNeeds
} = require("./runbook_dragon");

function nowMs() {
  return Date.now();
}

function missionEnabled(cfg = {}) {
  return cfg.assistantModeEnabled !== false
    && cfg.assistantMissionAdvisory !== false
    && cfg.coopObjectiveEnabled !== false
    && String(cfg.coopObjectiveType || "dragon_run") === "dragon_run";
}

function ensureMissionState(state, cfg = {}) {
  if (!state || typeof state !== "object") return null;

  if (!state.missionState || typeof state.missionState !== "object") {
    const legacy = state.objectiveRun && typeof state.objectiveRun === "object" ? state.objectiveRun : null;
    state.missionState = {
      id: legacy?.id || null,
      type: cfg.coopObjectiveType || "dragon_run",
      status: legacy?.status === "running" ? "active" : (legacy?.status || "idle"),
      phase: legacy?.phase || "bootstrap",
      needs: Array.isArray(legacy?.needs) ? legacy.needs : [],
      ownerLeader: legacy?.ownerLeader || cfg.owner || null,
      startedAt: legacy?.startedAt || null,
      updatedAt: nowMs(),
      lastSuggestion: legacy?.lastSuggestion || null,
      lastAcceptedTaskId: legacy?.lastAcceptedTaskId || null,
      lastFailure: legacy?.lastFailure || null,
      checkpoints: Array.isArray(legacy?.checkpoints) ? legacy.checkpoints : [],
      paused: legacy?.paused === true
    };
  }

  // Compatibility bridge for one release cycle.
  state.objectiveRun = {
    ...state.missionState,
    status: state.missionState.status === "active" ? "running" : state.missionState.status
  };

  return state.missionState;
}

function missionSnapshot(bot) {
  return {
    at: nowMs(),
    inventory: canonicalInventory(bot),
    position: bot?.entity?.position
      ? {
          x: Number(bot.entity.position.x),
          y: Number(bot.entity.position.y),
          z: Number(bot.entity.position.z)
        }
      : null
  };
}

function refreshMissionProgress(mission, snapshot, log = () => {}) {
  if (!mission || !snapshot) return;
  let safety = 0;
  while (
    mission.phase !== "dragon_fight"
    && mission.phase !== "complete"
    && isPhaseComplete(mission.phase, snapshot)
  ) {
    const prev = mission.phase;
    mission.phase = nextPhase(mission.phase);
    mission.updatedAt = nowMs();
    log({ type: "run_phase_complete", runId: mission.id, phase: prev });
    if (mission.phase !== "complete") {
      log({ type: "run_phase_enter", runId: mission.id, phase: mission.phase });
    }
    safety += 1;
    if (safety > RUN_PHASES.length + 2) break;
  }
  if (mission.phase === "complete") {
    mission.status = "complete";
  }
  mission.needs = phaseNeeds(mission.phase, snapshot);
}

function startMission(state, owner, cfg = {}, log = () => {}) {
  const mission = ensureMissionState(state, cfg);
  if (!missionEnabled(cfg)) {
    return { ok: false, code: "mission_disabled", reason: "assistant mission disabled" };
  }
  if (mission.status === "active" && !mission.paused) {
    return { ok: false, code: "mission_already_active", reason: "mission already active", mission };
  }
  mission.id = `mission_${Date.now()}`;
  mission.type = cfg.coopObjectiveType || "dragon_run";
  mission.status = "active";
  mission.phase = "bootstrap";
  mission.needs = [];
  mission.ownerLeader = owner || cfg.owner || mission.ownerLeader || null;
  mission.startedAt = nowMs();
  mission.updatedAt = nowMs();
  mission.lastSuggestion = null;
  mission.lastAcceptedTaskId = null;
  mission.lastFailure = null;
  mission.paused = false;
  mission.checkpoints = [];
  log({ type: "mission_start", missionId: mission.id, phase: mission.phase, owner: mission.ownerLeader });
  // Compatibility run lifecycle logs
  log({ type: "run_start", runId: mission.id, phase: mission.phase, owner: mission.ownerLeader });
  log({ type: "run_phase_enter", runId: mission.id, phase: mission.phase });
  return { ok: true, mission };
}

function pauseMission(state, cfg = {}, log = () => {}) {
  const mission = ensureMissionState(state, cfg);
  if (mission.status !== "active") {
    return { ok: false, code: "mission_not_active", reason: "mission not active", mission };
  }
  mission.status = "paused";
  mission.paused = true;
  mission.updatedAt = nowMs();
  log({ type: "mission_pause", missionId: mission.id, phase: mission.phase });
  return { ok: true, mission };
}

function resumeMission(state, cfg = {}, log = () => {}) {
  const mission = ensureMissionState(state, cfg);
  if (mission.status !== "paused") {
    return { ok: false, code: "mission_not_paused", reason: "mission not paused", mission };
  }
  mission.status = "active";
  mission.paused = false;
  mission.updatedAt = nowMs();
  log({ type: "mission_resume", missionId: mission.id, phase: mission.phase });
  return { ok: true, mission };
}

function abortMission(state, cfg = {}, log = () => {}) {
  const mission = ensureMissionState(state, cfg);
  if (mission.status === "idle" || mission.status === "aborted") {
    return { ok: false, code: "mission_not_active", reason: "mission not active", mission };
  }
  mission.status = "aborted";
  mission.paused = false;
  mission.updatedAt = nowMs();
  log({ type: "mission_abort", missionId: mission.id, phase: mission.phase });
  return { ok: true, mission };
}

function getMissionStatus(state, bot, cfg = {}, log = () => {}) {
  const mission = ensureMissionState(state, cfg);
  if (!mission) return { ok: false, code: "mission_missing", reason: "mission missing" };
  if (mission.status === "idle") {
    return {
      ok: true,
      mission,
      phase: mission.phase,
      needs: [],
      line: "mission: idle"
    };
  }
  const snapshot = missionSnapshot(bot);
  refreshMissionProgress(mission, snapshot, log);
  const needs = Array.isArray(mission.needs) ? mission.needs : [];
  const elapsed = mission.startedAt ? Math.max(0, Math.floor((nowMs() - mission.startedAt) / 1000)) : 0;
  const needsText = needs.length ? summarizeNeeds(needs, 5) : "none";
  return {
    ok: true,
    mission,
    phase: mission.phase,
    needs,
    line: `mission: ${mission.status} phase:${mission.phase} elapsed:${elapsed}s needs:${needsText}`
  };
}

function suggestNextTask(state, bot, cfg = {}, log = () => {}) {
  const status = getMissionStatus(state, bot, cfg, log);
  if (!status.ok) return status;
  const mission = status.mission;
  if (mission.status !== "active" || mission.paused) {
    return {
      ok: false,
      code: "mission_not_active",
      reason: "mission is not active",
      mission
    };
  }

  const snapshot = missionSnapshot(bot);
  const recommendation = proposePhaseRecommendation(mission.phase, snapshot, cfg);
  if (!recommendation?.intent) {
    return {
      ok: false,
      code: "no_recommendation",
      reason: "no recommendation available",
      mission,
      phase: mission.phase,
      needs: mission.needs || []
    };
  }

  const suggestion = {
    id: `suggest_${Date.now()}`,
    phase: mission.phase,
    intent: recommendation.intent,
    summary: recommendation.summary || recommendation.intent.type,
    reason: recommendation.reason || "best next step",
    source: recommendation.source || "rules",
    createdAt: nowMs()
  };

  mission.lastSuggestion = suggestion;
  mission.updatedAt = nowMs();
  log({
    type: "mission_suggest",
    missionId: mission.id,
    phase: mission.phase,
    summary: suggestion.summary,
    reason: suggestion.reason,
    intentType: suggestion.intent.type
  });
  return {
    ok: true,
    mission,
    phase: mission.phase,
    needs: mission.needs || [],
    suggestion
  };
}

function acceptSuggestion(state, cfg = {}, suggestion, taskId = null, log = () => {}) {
  const mission = ensureMissionState(state, cfg);
  if (!mission || !suggestion) {
    return { ok: false, code: "missing_suggestion", reason: "no pending mission suggestion", mission };
  }
  mission.lastSuggestion = {
    ...suggestion,
    acceptedAt: nowMs()
  };
  mission.lastAcceptedTaskId = taskId || mission.lastAcceptedTaskId || null;
  mission.updatedAt = nowMs();
  log({
    type: "mission_accept",
    missionId: mission.id,
    suggestionId: suggestion.id || null,
    intentType: suggestion.intent?.type || null
  });
  return { ok: true, mission };
}

function rejectSuggestion(state, cfg = {}, suggestion, log = () => {}) {
  const mission = ensureMissionState(state, cfg);
  if (!mission || !suggestion) {
    return { ok: false, code: "missing_suggestion", reason: "no pending mission suggestion", mission };
  }
  mission.lastSuggestion = {
    ...suggestion,
    rejectedAt: nowMs()
  };
  mission.updatedAt = nowMs();
  log({
    type: "mission_reject",
    missionId: mission.id,
    suggestionId: suggestion.id || null,
    intentType: suggestion.intent?.type || null
  });
  return { ok: true, mission };
}

function missionStatusLine(state, bot, cfg = {}, log = () => {}) {
  return getMissionStatus(state, bot, cfg, log).line || "mission: idle";
}

function missionPhaseLine(state, cfg = {}) {
  const mission = ensureMissionState(state, cfg);
  if (!mission || mission.status === "idle") return "mission phase: none";
  return `mission phase: ${mission.phase} (${phaseLabel(mission.phase)})`;
}

function missionPlanLine(state, bot, cfg = {}, log = () => {}) {
  const suggested = suggestNextTask(state, bot, cfg, log);
  if (!suggested.ok) return `mission plan: ${suggested.reason || "none"}`;
  return `mission plan: ${suggested.suggestion.summary} (${suggested.suggestion.reason})`;
}

// Backward compatible wrappers (one release cycle)
function runEnabled(cfg = {}) {
  return missionEnabled(cfg);
}

function ensureObjectiveRun(state, cfg = {}) {
  return ensureMissionState(state, cfg);
}

function startRun(state, owner, cfg = {}, log = () => {}) {
  const out = startMission(state, owner, cfg, log);
  if (out.ok) {
    out.run = out.mission;
  }
  return out;
}

function pauseRun(state, cfg = {}, log = () => {}) {
  const out = pauseMission(state, cfg, log);
  if (out.ok) out.run = out.mission;
  return out;
}

function resumeRun(state, cfg = {}, log = () => {}) {
  const out = resumeMission(state, cfg, log);
  if (out.ok) out.run = out.mission;
  return out;
}

function abortRun(state, cfg = {}, log = () => {}) {
  const out = abortMission(state, cfg, log);
  if (out.ok) out.run = out.mission;
  return out;
}

function completeRun(state, cfg = {}, log = () => {}, reason = "manual") {
  const mission = ensureMissionState(state, cfg);
  mission.status = "complete";
  mission.phase = "complete";
  mission.updatedAt = nowMs();
  log({ type: "mission_complete", missionId: mission.id, reason });
  log({ type: "run_complete", runId: mission.id, reason });
  return { ok: true, mission, run: mission };
}

function saveCheckpoint(state, bot, cfg = {}, log = () => {}, reason = "periodic") {
  const mission = ensureMissionState(state, cfg);
  if (!mission || cfg.runCheckpointingEnabled === false) return null;
  if (!mission.id || (mission.status !== "active" && mission.status !== "paused")) return null;
  const snap = missionSnapshot(bot);
  const cp = {
    at: snap.at,
    phase: mission.phase,
    reason,
    inventory: snap.inventory,
    position: snap.position
  };
  mission.checkpoints = Array.isArray(mission.checkpoints) ? mission.checkpoints : [];
  mission.checkpoints.push(cp);
  if (mission.checkpoints.length > 40) mission.checkpoints = mission.checkpoints.slice(-40);
  mission.updatedAt = nowMs();
  log({ type: "run_checkpoint_saved", runId: mission.id, phase: mission.phase, reason });
  return cp;
}

function autoStartMatch(text, cfg = {}) {
  const t = String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (Array.isArray(cfg.objectiveAutoStartPhrases)) {
    if (cfg.objectiveAutoStartPhrases.length === 0) return false;
    const configured = cfg.objectiveAutoStartPhrases
      .map((p) => String(p || "").trim())
      .filter(Boolean);
    if (!configured.length) return false;
    return configured.some((p) => t.includes(
      String(p || "")
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    ));
  }
  const phrases = ["lets beat minecraft", "beat minecraft", "start run"];
  return phrases.some((p) => t.includes(
    String(p || "")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  ));
}

function nextObjectiveIntent(state, bot, cfg = {}, log = () => {}) {
  log({
    type: "assistant_guard_block",
    reason: "objective_auto_dispatch_disabled",
    mode: "assistant_first"
  });
  const suggested = suggestNextTask(state, bot, cfg, log);
  if (!suggested.ok) return null;
  return {
    run: suggested.mission,
    phase: suggested.phase,
    step: null,
    intent: suggested.suggestion.intent,
    needs: suggested.needs
  };
}

function recordStepResult(state, cfg, stepInfo, taskResult, log = () => {}) {
  const mission = ensureMissionState(state, cfg);
  if (!mission) return;
  if (taskResult?.status === "success") {
    mission.lastFailure = null;
    mission.updatedAt = nowMs();
    return;
  }
  mission.lastFailure = {
    at: nowMs(),
    status: taskResult?.status || "fail",
    code: taskResult?.code || null,
    reason: taskResult?.reason || "failed",
    nextNeed: taskResult?.nextNeed || null
  };
  mission.updatedAt = nowMs();
  log({
    type: "run_step_fail",
    runId: mission.id,
    phase: mission.phase,
    status: taskResult?.status || "fail",
    code: taskResult?.code || null,
    reason: taskResult?.reason || "failed"
  });
}

function runStatusLine(state, cfg = {}) {
  const mission = ensureMissionState(state, cfg);
  if (!mission || mission.status === "idle") return "run: idle";
  const elapsedSec = mission.startedAt ? Math.max(0, Math.floor((nowMs() - mission.startedAt) / 1000)) : 0;
  const runStatus = mission.status === "active" ? "running" : mission.status;
  return `run: ${runStatus} phase:${mission.phase} elapsed:${elapsedSec}s`;
}

function runPhaseLine(state, cfg = {}) {
  return missionPhaseLine(state, cfg).replace(/^mission/, "run");
}

function runPlanLine(state, bot, cfg = {}, log = () => {}) {
  const suggested = suggestNextTask(state, bot, cfg, log);
  if (!suggested.ok) return `run plan: ${suggested.reason || "none"}`;
  return `run plan: ${suggested.suggestion.summary}`;
}

module.exports = {
  missionEnabled,
  ensureMissionState,
  startMission,
  pauseMission,
  resumeMission,
  abortMission,
  getMissionStatus,
  suggestNextTask,
  acceptSuggestion,
  rejectSuggestion,
  missionStatusLine,
  missionPhaseLine,
  missionPlanLine,
  // Compatibility exports
  runEnabled,
  ensureObjectiveRun,
  autoStartMatch,
  startRun,
  pauseRun,
  resumeRun,
  abortRun,
  completeRun,
  saveCheckpoint,
  nextObjectiveIntent,
  recordStepResult,
  runStatusLine,
  runPhaseLine,
  runPlanLine
};
