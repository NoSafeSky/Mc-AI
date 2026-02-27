const test = require("node:test");
const assert = require("node:assert/strict");

const {
  enqueueCommand,
  dequeueCommand,
  clearQueue,
  queueSummary
} = require("../brain/assistant_queue");

test("enqueue/dequeue preserves FIFO order", () => {
  const q = [];
  const cfg = { assistantQueueEnabled: true, assistantQueuePolicy: "fifo", assistantQueueMax: 10 };
  enqueueCommand(q, { from: "owner", rawText: "first", intent: { type: "follow" } }, cfg);
  enqueueCommand(q, { from: "owner", rawText: "second", intent: { type: "come" } }, cfg);
  assert.equal(q.length, 2);
  const a = dequeueCommand(q);
  const b = dequeueCommand(q);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.item.rawText, "first");
  assert.equal(b.item.rawText, "second");
});

test("queue full rejects new items", () => {
  const q = [];
  const cfg = { assistantQueueEnabled: true, assistantQueuePolicy: "fifo", assistantQueueMax: 1 };
  const first = enqueueCommand(q, { from: "owner", rawText: "one", intent: { type: "follow" } }, cfg);
  const second = enqueueCommand(q, { from: "owner", rawText: "two", intent: { type: "come" } }, cfg);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.code, "queue_full");
});

test("queue summary and clear return expected values", () => {
  const q = [];
  const cfg = { assistantQueueEnabled: true, assistantQueuePolicy: "fifo", assistantQueueMax: 10 };
  enqueueCommand(q, { from: "owner", rawText: "one", intent: { type: "follow" } }, cfg);
  const summary = queueSummary(q);
  assert.equal(summary.size, 1);
  const cleared = clearQueue(q);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.cleared, 1);
  assert.equal(q.length, 0);
});
