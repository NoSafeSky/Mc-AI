const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");

const {
  ensureMissionState,
  startMission,
  pauseMission,
  resumeMission,
  abortMission,
  suggestNextTask,
  acceptSuggestion,
  rejectSuggestion,
  missionStatusLine,
  autoStartMatch
} = require("../brain/objective_manager");

function makeState() {
  return {
    creepy: false,
    stopped: false,
    base: null,
    doNotTouch: [],
    missionState: null,
    objectiveRun: null
  };
}

function makeBot(items = []) {
  return {
    version: "1.21.1",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: {
      items: () => items
    }
  };
}

test("startMission initializes assistant mission state", () => {
  const state = makeState();
  const cfg = { owner: "NoSafeSky", assistantModeEnabled: true, assistantMissionAdvisory: true, coopObjectiveEnabled: true, coopObjectiveType: "dragon_run" };
  ensureMissionState(state, cfg);
  const started = startMission(state, "NoSafeSky", cfg, () => {});
  assert.equal(started.ok, true);
  assert.equal(state.missionState.status, "active");
  assert.equal(state.missionState.phase, "bootstrap");
});

test("pause and resume update mission status", () => {
  const state = makeState();
  const cfg = { owner: "NoSafeSky", assistantModeEnabled: true, assistantMissionAdvisory: true, coopObjectiveEnabled: true, coopObjectiveType: "dragon_run" };
  startMission(state, "NoSafeSky", cfg, () => {});
  const paused = pauseMission(state, cfg, () => {});
  assert.equal(paused.ok, true);
  assert.equal(state.missionState.status, "paused");
  const resumed = resumeMission(state, cfg, () => {});
  assert.equal(resumed.ok, true);
  assert.equal(state.missionState.status, "active");
});

test("suggestNextTask returns one deterministic recommendation", () => {
  const state = makeState();
  const cfg = {
    owner: "NoSafeSky",
    assistantModeEnabled: true,
    assistantMissionAdvisory: true,
    coopObjectiveEnabled: true,
    coopObjectiveType: "dragon_run",
    tacticalLlmEnabled: false
  };
  startMission(state, "NoSafeSky", cfg, () => {});
  const out = suggestNextTask(state, makeBot([]), cfg, () => {});
  assert.equal(out.ok, true);
  assert.equal(out.phase, "bootstrap");
  assert.ok(out.suggestion);
  assert.ok(out.suggestion.intent);
  assert.equal(typeof out.suggestion.summary, "string");
});

test("acceptSuggestion and rejectSuggestion update mission metadata", () => {
  const state = makeState();
  const cfg = { owner: "NoSafeSky", assistantModeEnabled: true, assistantMissionAdvisory: true, coopObjectiveEnabled: true, coopObjectiveType: "dragon_run" };
  startMission(state, "NoSafeSky", cfg, () => {});

  const suggestion = {
    id: "s1",
    intent: { type: "craftItem", item: "wooden_pickaxe", count: 1 },
    summary: "craft wooden_pickaxe x1",
    reason: "bootstrap need"
  };
  const accepted = acceptSuggestion(state, cfg, suggestion, 42, () => {});
  assert.equal(accepted.ok, true);
  assert.equal(state.missionState.lastAcceptedTaskId, 42);
  assert.equal(state.missionState.lastSuggestion.id, "s1");

  const rejected = rejectSuggestion(state, cfg, suggestion, () => {});
  assert.equal(rejected.ok, true);
  assert.equal(state.missionState.lastSuggestion.id, "s1");
});

test("abortMission marks mission aborted", () => {
  const state = makeState();
  const cfg = { owner: "NoSafeSky", assistantModeEnabled: true, assistantMissionAdvisory: true, coopObjectiveEnabled: true, coopObjectiveType: "dragon_run" };
  startMission(state, "NoSafeSky", cfg, () => {});
  const out = abortMission(state, cfg, () => {});
  assert.equal(out.ok, true);
  assert.equal(state.missionState.status, "aborted");
  assert.match(missionStatusLine(state, makeBot([]), cfg, () => {}), /aborted/i);
});

test("autoStartMatch respects explicit empty phrase list", () => {
  const cfg = { objectiveAutoStartPhrases: [] };
  assert.equal(autoStartMatch("let's beat minecraft", cfg), false);
  assert.equal(autoStartMatch("start run", cfg), false);
});

test("autoStartMatch uses configured phrases only", () => {
  const cfg = { objectiveAutoStartPhrases: ["begin mission"] };
  assert.equal(autoStartMatch("begin mission now", cfg), true);
  assert.equal(autoStartMatch("let's beat minecraft", cfg), false);
});

test("autoStartMatch falls back to defaults only when config missing", () => {
  assert.equal(autoStartMatch("let's beat minecraft", {}), true);
  assert.equal(autoStartMatch("start run", {}), true);
});
