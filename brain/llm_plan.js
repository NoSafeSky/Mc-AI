const fetch = require("node-fetch");

const ALLOWED_ACTIONS = new Set([
  "explore",
  "seekVillage",
  "harvestWood",
  "craftBasic",
  "attackHostile",
  "huntFood",
  "attackMob",
  "followOwner",
  "comeOwner",
  "wait"
]);

function sanitizePlan(plan, cfg) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.steps)) return null;
  const maxRadius = cfg.maxExploreRadius || 500;
  const steps = plan.steps
    .map((s) => ({
      action: s.action,
      mobType: typeof s.mobType === "string" ? s.mobType.toLowerCase() : undefined,
      radius: Math.min(maxRadius, Math.max(32, s.radius || maxRadius)),
      seconds: Math.min(300, Math.max(5, s.seconds || 30))
    }))
    .filter((s) => ALLOWED_ACTIONS.has(s.action));
  if (!steps.length) return null;
  return { steps };
}

async function llmPlan(message, cfg, state) {
  const provider = (cfg.llmProvider || "groq").toLowerCase();
  const model = cfg.llmModel || "llama-3.3-70b-versatile";
  const maxRadius = cfg.maxExploreRadius || 500;

  const system = `You are a planner for a Minecraft bot. Return ONLY valid JSON.
Allowed actions: explore, seekVillage, harvestWood, craftBasic, attackHostile, huntFood, attackMob, followOwner, comeOwner, wait.
Use small number of steps (1-4). No extra text.`;

  const prompt = `owner=${cfg.owner}
maxRadius=${maxRadius}
message="${message}"
Return JSON like: {"steps":[{"action":"explore","radius":300,"seconds":60}]}
For "kill a pig" use: {"steps":[{"action":"attackMob","mobType":"pig","seconds":60}]}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.llmTimeoutMs || 3000);

  try {
    if (provider === "groq") {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) return null;
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt }
          ],
          temperature: 0.2
        }),
        signal: controller.signal
      });
      if (!res.ok) return null;
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim() || "";
      const parsed = JSON.parse(text);
      return sanitizePlan(parsed, cfg);
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { llmPlan };