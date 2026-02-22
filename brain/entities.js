const LIVING_ENTITY_TYPES = new Set([
  "animal",
  "hostile",
  "passive",
  "water_creature",
  "ambient",
  "living",
  "mob"
]);

const EXCLUDED_ENTITY_TYPES = new Set(["player", "projectile", "other"]);

function normalizeEntityName(name) {
  const normalized = String(name || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
  return normalized || null;
}

function resolveAlias(name, aliases) {
  if (!aliases) return name;
  if (aliases instanceof Map) {
    return normalizeEntityName(aliases.get(name)) || name;
  }
  if (typeof aliases === "object") {
    return normalizeEntityName(aliases[name]) || name;
  }
  return name;
}

function isLivingNonPlayerEntity(entity) {
  if (!entity || !entity.position) return false;
  const type = normalizeEntityName(entity.type);
  if (!type) return false;
  if (EXCLUDED_ENTITY_TYPES.has(type)) return false;
  if (LIVING_ENTITY_TYPES.has(type)) return true;
  const kind = String(entity.kind || "").toLowerCase();
  return kind.includes("mob") || kind.includes("creature") || kind.includes("animal");
}

function getCanonicalEntityName(entity) {
  if (!entity) return null;
  const fromName = normalizeEntityName(entity.name);
  if (fromName && fromName !== "unknown") return fromName;
  const fromDisplay = normalizeEntityName(entity.displayName);
  if (fromDisplay && fromDisplay !== "unknown") return fromDisplay;
  return null;
}

function matchesTargetNameStrict(entityName, targetName, aliases = null) {
  const entity = normalizeEntityName(entityName);
  const target = normalizeEntityName(targetName);
  if (!entity || !target) return false;
  if (entity === target) return true;
  const entityResolved = resolveAlias(entity, aliases);
  const targetResolved = resolveAlias(target, aliases);
  return entityResolved === targetResolved;
}

module.exports = {
  LIVING_ENTITY_TYPES,
  EXCLUDED_ENTITY_TYPES,
  normalizeEntityName,
  isLivingNonPlayerEntity,
  getCanonicalEntityName,
  matchesTargetNameStrict
};
