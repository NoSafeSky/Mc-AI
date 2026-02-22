const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getBlockToolRequirement,
  isToolSufficient
} = require("../brain/block_compat");

const mcData = require("minecraft-data")("1.21.1");

test("stone/cobblestone/cobbled_deepslate require pickaxe tools", () => {
  const names = ["stone", "cobblestone", "cobbled_deepslate"];
  for (const name of names) {
    const block = mcData.blocksByName[name];
    const req = getBlockToolRequirement(block, mcData);
    assert.ok(req);
    assert.equal(req.toolType, "pickaxe");
    assert.equal(typeof req.minTier, "string");
    assert.equal(req.acceptedTools.some((t) => t.endsWith("_pickaxe")), true);
  }
});

test("tool sufficiency check respects tier and tool type", () => {
  const stoneReq = getBlockToolRequirement(mcData.blocksByName.stone, mcData);
  assert.equal(isToolSufficient("wooden_pickaxe", stoneReq), true);
  assert.equal(isToolSufficient("stone_pickaxe", stoneReq), true);
  assert.equal(isToolSufficient("iron_pickaxe", stoneReq), true);
  assert.equal(isToolSufficient("wooden_axe", stoneReq), false);
  assert.equal(isToolSufficient("hand", stoneReq), false);
});
