const fs = require("fs");
const path = require("path");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function safeReadJson(filePath, fallback = {}) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readJsonl(filePath, fallback = []) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return fallback;
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return fallback;
  }
}

function writeJsonl(filePath, rows = []) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const lines = (rows || []).map((row) => JSON.stringify(row));
  fs.writeFileSync(filePath, lines.join("\n") + (lines.length ? "\n" : ""));
}

function appendJsonlBounded(filePath, row, maxRecords = 1000) {
  const rows = readJsonl(filePath, []);
  rows.push(row);
  const bounded = rows.slice(-Math.max(1, Number(maxRecords || 1)));
  writeJsonl(filePath, bounded);
  return bounded.length;
}

module.exports = {
  ensureDir,
  safeReadJson,
  safeWriteJson,
  readJsonl,
  writeJsonl,
  appendJsonlBounded
};

