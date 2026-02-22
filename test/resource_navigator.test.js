const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");

const { autoRelocateForResource } = require("../brain/resource_navigator");

function makeBot() {
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    pathfinder: {
      setGoal(goal) {
        if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
          bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        }
      }
    },
    waitForTicks: async () => {},
    findBlocks({ maxDistance }) {
      if (maxDistance >= 192) return [new Vec3(40, 64, 40)];
      if (maxDistance >= 120) return [new Vec3(20, 64, 20)];
      return [];
    }
  };
  return bot;
}

let bot = null;

test("resource navigator uses configured relocation rings", async () => {
  bot = makeBot();
  const events = [];
  const cfg = {
    missingResourcePolicy: "auto_relocate",
    missingResourceAutoRings: [120, 192, 256],
    missingResourceMaxRelocations: 3,
    missingResourceRelocateTimeoutSec: 2
  };

  const a = await autoRelocateForResource(bot, "log", cfg, { id: 1, isCancelled: () => false }, (evt) => events.push(evt), { relocationCount: 0 });
  assert.equal(a.ok, true);
  assert.equal(events.some((e) => e.type === "relocate_start" && e.ring === 120), true);

  const b = await autoRelocateForResource(bot, "log", cfg, { id: 1, isCancelled: () => false }, (evt) => events.push(evt), { relocationCount: 1 });
  assert.equal(b.ok, true);
  assert.equal(events.some((e) => e.type === "relocate_start" && e.ring === 192), true);
});

test("resource navigator fails after max relocation count", async () => {
  bot = makeBot();
  const cfg = {
    missingResourcePolicy: "auto_relocate",
    missingResourceAutoRings: [120, 192, 256],
    missingResourceMaxRelocations: 3
  };
  const res = await autoRelocateForResource(
    bot,
    "cobblestone",
    cfg,
    { id: 2, isCancelled: () => false },
    () => {},
    { relocationCount: 3 }
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "relocate_limit_exhausted");
});
