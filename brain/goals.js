// Simple goal selector based on perception snapshot

function selectGoal(p) {
  // Survival first
  if (p.hp <= 10 || (p.mobs || []).some(m => m.dist < 6)) {
    return "follow_owner"; // regroup for safety
  }

  // Food if low
  if (p.food <= 10) return "food";

  // Basic progression
  if (!p.hasWood) return "gather_wood";
  if (!p.hasStone) return "gather_stone";
  if (!p.hasIron) return "gather_iron";

  // If we have wood but no sticks/pick, try basic craft
  return "craft_basic";

  // Fallback
  // If night and weak armor, stay near owner
  // Otherwise explore
  // (Reached only if craft_basic is skipped by earlier returns)
}

module.exports = { selectGoal };