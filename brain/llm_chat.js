const fetch = require("node-fetch");

async function llmChatReply(message, cfg, history = []) {
  const provider = (cfg.llmProvider || "ollama").toLowerCase();
  const model = cfg.llmModel || "gemini-3.0-flash";
  const maxTokens = cfg.chatMaxTokens || 80;

  const system = `You are a friendly Minecraft bot assistant. Reply in 1 short sentence. No emojis. Avoid commands. Use recent chat context if provided.`;
  const historyText = history.length
    ? `Recent chat:\n${history.map((h) => `${h.role}: ${h.text}`).join("\n")}`
    : "";
  const prompt = `${historyText}\nPlayer says: "${message}"\nReply:`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.llmTimeoutMs || 3000);

  try {
    if (provider === "groq") {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) return null;
      const url = "https://api.groq.com/openai/v1/chat/completions";
      const body = {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt }
        ],
        temperature: 0.6,
        max_tokens: maxTokens
      };
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.log("Groq chat HTTP", res.status, errText.slice(0, 200));
        return null;
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim() || null;
      if (!text) console.log("Groq chat empty response");
      return text;
    }

    if (provider === "gemini") {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return null;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const body = {
        contents: [{ role: "user", parts: [{ text: `${system}\n\n${prompt}` }] }],
        generationConfig: { temperature: 0.6, maxOutputTokens: maxTokens }
      };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.log("Gemini chat HTTP", res.status, errText.slice(0, 200));
        return null;
      }
      const data = await res.json();
      return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    }

    // Ollama fallback
    const body = {
      model,
      system,
      prompt,
      stream: false,
      options: { temperature: 0.6, num_predict: maxTokens }
    };
    const res = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.log("Ollama chat HTTP", res.status, errText.slice(0, 200));
      return null;
    }
    const data = await res.json();
    return (data.response || "").trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { llmChatReply };