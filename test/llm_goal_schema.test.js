const test = require("node:test");
const assert = require("node:assert/strict");

const { parseRouteText, validateRouteObject } = require("../brain/llm_goal_schema");

test("goal schema rejects unknown goal type", () => {
  const out = validateRouteObject(
    {
      kind: "action",
      confidence: 0.9,
      goals: [{ type: "doAnything", args: {} }]
    },
    { owner: "NoSafeSky", maxGoals: 5 }
  );

  assert.equal(out.ok, false);
  assert.equal(out.reasonCode, "unknown_goal_type");
});

test("goal schema rejects missing craft item", () => {
  const out = validateRouteObject(
    {
      kind: "action",
      confidence: 0.9,
      goals: [{ type: "craftItem", args: {} }]
    },
    { owner: "NoSafeSky", maxGoals: 5 }
  );

  assert.equal(out.ok, false);
  assert.equal(out.reasonCode, "missing_craft_item");
});

test("goal schema enforces max goals", () => {
  const out = validateRouteObject(
    {
      kind: "action",
      confidence: 0.9,
      goals: [
        { type: "follow", args: {} },
        { type: "come", args: {} },
        { type: "harvest", args: {} }
      ]
    },
    { owner: "NoSafeSky", maxGoals: 2 }
  );

  assert.equal(out.ok, false);
  assert.equal(out.reasonCode, "too_many_goals");
});

test("parse route text returns normalized action route", () => {
  const parsed = parseRouteText(
    '{"kind":"action","confidence":0.88,"goals":[{"type":"attackMob","args":{"mobType":"Pig"}}]}',
    { owner: "NoSafeSky", maxGoals: 5 }
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.kind, "action");
  assert.equal(parsed.value.goals[0].type, "attackMob");
  assert.equal(parsed.value.goals[0].args.mobType, "pig");
});

test("goal schema accepts mission and give item goals", () => {
  const out = validateRouteObject(
    {
      kind: "action",
      confidence: 0.9,
      goals: [
        { type: "missionStart", args: {} },
        { type: "giveItem", args: { item: "cobblestone", count: 4 } }
      ]
    },
    { owner: "NoSafeSky", maxGoals: 5 }
  );
  assert.equal(out.ok, true);
  assert.equal(out.value.goals[0].type, "missionStart");
  assert.equal(out.value.goals[1].type, "giveItem");
});

test("goal schema normalizes deprecated run aliases", () => {
  const out = validateRouteObject(
    {
      kind: "action",
      confidence: 0.9,
      goals: [
        { type: "startObjectiveRun", args: {} },
        { type: "runStatus", args: {} },
        { type: "runNext", args: {} }
      ]
    },
    { owner: "NoSafeSky", maxGoals: 5 }
  );
  assert.equal(out.ok, true);
  assert.equal(out.value.goals[0].type, "missionStart");
  assert.equal(out.value.goals[1].type, "missionStatus");
  assert.equal(out.value.goals[2].type, "missionSuggest");
});
