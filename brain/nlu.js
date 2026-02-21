function parseNLU(text, cfg) {
  if (!text) return { type: "none" };
  const t = String(text).toLowerCase();

  if (t.includes("stalk me") || t.includes("stalk")) return { type: "stalk", target: cfg.owner };

  if (t.includes("follow me") || t.startsWith("follow ")) return { type: "follow", target: cfg.owner };
  if (t.includes("come here") || t.includes("come to me") || t === "come" || t.startsWith("come ")) return { type: "come", target: cfg.owner };

  if (t.includes("be creepy") || t.includes("creepy mode") || t.includes("creepy on")) return { type: "setCreepy", value: true };
  if (t.includes("be normal") || t.includes("normal mode") || t.includes("creepy off")) return { type: "setCreepy", value: false };

  if (t === "stop" || t.includes("stop moving") || t.includes("stop following")) return { type: "stop" };
  if (t.includes("stop all") || t.includes("stop everything") || t.includes("!stopall")) return { type: "stopall" };
  if (t.includes("resume")) return { type: "resume" };
  if (t.includes("harvest") || t.includes("chop")) return { type: "harvest" };

  return { type: "none" };
}

module.exports = { parseNLU };
