const DEFAULT_TRAITS = {
  directness: 0.8,
  warmth: 0.4,
  caution: 0.7
};

function moodPromptPrefix(mood) {
  const m = String(mood || "content");
  if (m === "excited") return "Tone: concise and upbeat.";
  if (m === "cautious") return "Tone: concise and careful.";
  if (m === "anxious") return "Tone: concise and uncertainty-aware.";
  if (m === "frustrated") return "Tone: concise, factual, calm.";
  return "Tone: concise and neutral.";
}

module.exports = {
  DEFAULT_TRAITS,
  moodPromptPrefix
};

