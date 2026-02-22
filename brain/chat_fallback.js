function buildUnavailableReply(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "i could not generate a reply right now. try again.";
  const snippet = raw.replace(/["`]/g, "").slice(0, 72);
  if (!snippet) return "i could not generate a reply right now. try again.";
  if (snippet.endsWith("?")) {
    return `i could not answer "${snippet}" right now. ask again in a moment.`;
  }
  return `i saw "${snippet}", but i could not generate a full reply right now.`;
}

module.exports = {
  buildUnavailableReply
};
