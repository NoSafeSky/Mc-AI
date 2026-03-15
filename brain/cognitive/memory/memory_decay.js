function decayedImportance(importance, lastAccessTs, now = Date.now()) {
  const base = Math.max(0, Number(importance || 0));
  const ageMs = Math.max(0, Number(now - Number(lastAccessTs || now)));
  const days = ageMs / 86400000;
  const factor = 1 - (0.05 * Math.log(days + 1));
  return Number((base * Math.max(0, factor)).toFixed(6));
}

function pruneByImportance(rows = [], options = {}) {
  const now = Number(options.now || Date.now());
  const minImportance = Number(options.minImportance ?? 0.15);
  const maxRecords = Math.max(1, Number(options.maxRecords || rows.length || 1));
  const decorated = (rows || []).map((row) => ({
    row,
    score: decayedImportance(row.importance || 0, row.lastAccessTs || row.ts || now, now)
  }));
  const kept = decorated
    .filter((entry) => entry.score >= minImportance)
    .sort((a, b) => (b.score - a.score) || (Number(b.row.ts || 0) - Number(a.row.ts || 0)))
    .slice(0, maxRecords)
    .map((entry) => entry.row);
  return kept;
}

module.exports = {
  decayedImportance,
  pruneByImportance
};

