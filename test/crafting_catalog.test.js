const test = require("node:test");
const assert = require("node:assert/strict");

const { parseCraftRequest } = require("../brain/crafting_catalog");

test("parse craft me a wooden sword", () => {
  const req = parseCraftRequest("craft me a wooden sword", 1);
  assert.equal(req.isCraftPhrase, true);
  assert.equal(req.item, "wooden_sword");
  assert.equal(req.count, 1);
});

test("parse make 2 stone pickaxes", () => {
  const req = parseCraftRequest("make 2 stone pickaxes", 1);
  assert.equal(req.isCraftPhrase, true);
  assert.equal(req.item, "stone_pickaxe");
  assert.equal(req.count, 2);
});

test("dynamic craft item resolves canonical target", () => {
  const req = parseCraftRequest("craft me an iron sword", 1);
  assert.equal(req.isCraftPhrase, true);
  assert.equal(req.item, "iron_sword");
});

test("unknown craft target returns null item", () => {
  const req = parseCraftRequest("craft me a banana sword", 1);
  assert.equal(req.isCraftPhrase, true);
  assert.equal(req.item, null);
});
