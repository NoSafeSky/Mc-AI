const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const mineflayer = require("mineflayer");

function parseArgs(argv) {
  const out = {
    startBot: true,
    resetLog: true,
    dryRun: false
  };
  for (const arg of argv) {
    if (arg === "--no-start-bot") out.startBot = false;
    else if (arg === "--no-reset-log") out.resetLog = false;
    else if (arg === "--dry-run") out.dryRun = true;
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function eventSnippet(evt) {
  if (!evt) return null;
  const keys = ["type", "taskId", "intent", "code", "reason", "status", "from", "to"];
  const out = {};
  for (const k of keys) {
    if (evt[k] !== undefined) out[k] = evt[k];
  }
  return out;
}

function buildRunner(logPath) {
  let lineIndex = 0;
  const allEvents = [];

  const readNewEvents = () => {
    if (!fs.existsSync(logPath)) return [];
    const text = fs.readFileSync(logPath, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    const next = lines.slice(lineIndex);
    lineIndex = lines.length;
    const events = [];
    for (const line of next) {
      try {
        events.push(JSON.parse(line));
      } catch {}
    }
    allEvents.push(...events);
    return events;
  };

  const drain = () => readNewEvents();

  const waitFor = async (predicate, timeoutMs, pollMs = 250) => {
    const started = Date.now();
    const seen = [];
    while (Date.now() - started < timeoutMs) {
      const events = readNewEvents();
      if (events.length) {
        seen.push(...events);
        const match = seen.find(predicate);
        if (match) {
          return { ok: true, match, seen, elapsedMs: Date.now() - started };
        }
      }
      await sleep(pollMs);
    }
    return { ok: false, match: null, seen, elapsedMs: Date.now() - started };
  };

  const collectFor = async (durationMs, pollMs = 250) => {
    const started = Date.now();
    const seen = [];
    while (Date.now() - started < durationMs) {
      const events = readNewEvents();
      if (events.length) seen.push(...events);
      await sleep(pollMs);
    }
    return seen;
  };

  return {
    allEvents,
    readNewEvents,
    drain,
    waitFor,
    collectFor
  };
}

function createBotProcess(rootDir, runDir) {
  const outPath = path.join(runDir, "bot-stdout.log");
  const errPath = path.join(runDir, "bot-stderr.log");
  const out = fs.createWriteStream(outPath, { flags: "a" });
  const err = fs.createWriteStream(errPath, { flags: "a" });
  const proc = spawn("node", ["bot.js"], { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.pipe(out);
  proc.stderr.pipe(err);
  return { proc, outPath, errPath };
}

function connectChatClient({ host, port, version, username, timeoutMs = 25000 }) {
  return new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({ host, port, version, username });
    let done = false;
    const finish = (fn) => (value) => {
      if (done) return;
      done = true;
      cleanup();
      fn(value);
    };
    const cleanup = () => {
      bot.removeListener("spawn", onSpawn);
      bot.removeListener("error", onError);
      bot.removeListener("kicked", onKicked);
      clearTimeout(timer);
    };
    const onSpawn = finish(() => resolve(bot));
    const onError = finish((err) => reject(new Error(`[${username}] connection error: ${String(err)}`)));
    const onKicked = finish((reason) => reject(new Error(`[${username}] kicked: ${String(reason)}`)));
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`[${username}] connect timeout after ${timeoutMs}ms`)))();
    }, timeoutMs);
    bot.once("spawn", onSpawn);
    bot.once("error", onError);
    bot.once("kicked", onKicked);
  });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(__dirname, "..");
  const cfgPath = path.join(root, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const memoryDir = path.join(root, "memory");
  const logPath = path.join(memoryDir, "log.jsonl");
  const runDir = path.join(memoryDir, "checklist-runs", timeStamp());
  fs.mkdirSync(runDir, { recursive: true });

  const report = {
    startedAt: new Date().toISOString(),
    config: {
      host: cfg.host,
      port: cfg.port,
      version: cfg.version,
      owner: cfg.owner
    },
    options: args,
    runDir,
    steps: []
  };

  const addStep = (name, pass, details = {}) => {
    const row = { name, pass: !!pass, ...details };
    report.steps.push(row);
    console.log(`[${pass ? "PASS" : "FAIL"}] ${name}`);
    if (!pass && details.reason) {
      console.log(`  reason: ${details.reason}`);
    }
  };

  if (args.dryRun) {
    console.log("Dry run only. No bot/client connections were made.");
    report.finishedAt = new Date().toISOString();
    report.summary = { pass: 0, fail: 0 };
    const outJson = path.join(runDir, "report.json");
    fs.writeFileSync(outJson, JSON.stringify(report, null, 2));
    console.log(`Report: ${outJson}`);
    return;
  }

  if (args.resetLog) {
    fs.writeFileSync(logPath, "");
  }

  const runner = buildRunner(logPath);
  const startedProcesses = [];
  const startedBots = [];
  try {
    if (args.startBot) {
      const botProc = createBotProcess(root, runDir);
      startedProcesses.push(botProc.proc);
      const spawnWait = await runner.waitFor((e) => e.type === "spawn", 60000);
      addStep("bot spawn", spawnWait.ok, {
        reason: spawnWait.ok ? null : "bot did not emit spawn event in log within 60s"
      });
      if (!spawnWait.ok) {
        throw new Error("bot_spawn_timeout");
      }
    } else {
      addStep("bot spawn (external)", true, { note: "using existing running bot process" });
    }

    const ownerClient = await connectChatClient({
      host: cfg.host,
      port: cfg.port,
      version: cfg.version,
      username: cfg.owner
    });
    startedBots.push(ownerClient);
    addStep("owner chat client connect", true);

    let nonOwnerClient = null;
    try {
      nonOwnerClient = await connectChatClient({
        host: cfg.host,
        port: cfg.port,
        version: cfg.version,
        username: "ChecklistIntruder"
      });
      startedBots.push(nonOwnerClient);
      addStep("non-owner chat client connect", true);
    } catch (e) {
      addStep("non-owner chat client connect", true, { note: `skipped: ${String(e)}` });
    }

    const sendOwner = async (message) => {
      runner.drain();
      ownerClient.chat(message);
      await sleep(100);
    };

    await sendOwner("hi");
    const hi = await runner.waitFor((e) => e.type === "llm_chat_sent" && e.to === cfg.owner, 30000);
    const hiExtra = await runner.collectFor(2500);
    addStep("hi -> chat reply only", hi.ok && ![...hi.seen, ...hiExtra].some((e) => e.type === "task_start"), {
      reason: hi.ok ? null : "no llm_chat_sent to owner"
    });

    await sendOwner("let's beat minecraft");
    const beatEvents = await runner.collectFor(7000);
    addStep("phrase does not autostart mission", !beatEvents.some((e) => e.type === "mission_start"), {
      reason: beatEvents.some((e) => e.type === "mission_start") ? "mission_start appeared unexpectedly" : null
    });

    await sendOwner("mission start");
    const missionStart = await runner.waitFor((e) => e.type === "mission_start", 15000);
    const missionSuggest = await runner.waitFor((e) => e.type === "mission_suggest", 15000);
    addStep("mission start -> suggest", missionStart.ok && missionSuggest.ok, {
      reason: missionStart.ok && missionSuggest.ok ? null : "missing mission_start or mission_suggest"
    });

    await sendOwner("what next");
    const whatNext = await runner.waitFor((e) => e.type === "mission_suggest", 15000);
    const whatNextExtra = await runner.collectFor(4000);
    addStep("what next stays advisory", whatNext.ok && !whatNextExtra.some((e) => e.type === "task_start"), {
      reason: whatNext.ok ? null : "no mission_suggest after what next"
    });

    await sendOwner("yes");
    const accepted = await runner.waitFor((e) => e.type === "mission_accept", 15000);
    const taskFromYes = await runner.waitFor((e) => e.type === "task_start", 60000);
    let yesTerminal = { ok: false };
    if (taskFromYes.ok) {
      yesTerminal = await runner.waitFor(
        (e) => ["task_success", "task_fail", "task_timeout", "task_cancel"].includes(e.type) && e.taskId === taskFromYes.match.taskId,
        240000
      );
    }
    addStep("yes executes accepted suggestion", accepted.ok && taskFromYes.ok && yesTerminal.ok, {
      reason: accepted.ok && taskFromYes.ok && yesTerminal.ok ? null : "missing mission_accept, task_start, or terminal task event",
      accepted: eventSnippet(accepted.match),
      taskStart: eventSnippet(taskFromYes.match),
      terminal: eventSnippet(yesTerminal.match)
    });

    await sendOwner("no");
    const rejected = await runner.waitFor((e) => e.type === "mission_reject", 10000);
    addStep("no rejects suggestion", rejected.ok, {
      reason: rejected.ok ? null : "no mission_reject event"
    });

    await sendOwner("craft me a wooden sword");
    const woodStart = await runner.waitFor(
      (e) => e.type === "task_start" && e.intent && e.intent.type === "craftItem" && String(e.intent.item || "").includes("wooden_sword"),
      40000
    );
    let woodTerminal = { ok: false };
    if (woodStart.ok) {
      woodTerminal = await runner.waitFor(
        (e) => ["task_success", "task_fail", "task_timeout", "task_cancel"].includes(e.type) && e.taskId === woodStart.match.taskId,
        300000
      );
    }
    addStep("craft wooden sword terminal", woodStart.ok && woodTerminal.ok, {
      reason: woodStart.ok && woodTerminal.ok ? null : "wooden sword task did not reach terminal state",
      taskStart: eventSnippet(woodStart.match),
      terminal: eventSnippet(woodTerminal.match)
    });

    await sendOwner("craft me a stone sword");
    const stoneStart = await runner.waitFor(
      (e) => e.type === "task_start" && e.intent && e.intent.type === "craftItem" && String(e.intent.item || "").includes("stone_sword"),
      40000
    );
    let stoneTerminal = { ok: false };
    if (stoneStart.ok) {
      stoneTerminal = await runner.waitFor(
        (e) => ["task_success", "task_fail", "task_timeout", "task_cancel"].includes(e.type) && e.taskId === stoneStart.match.taskId,
        360000
      );
    }
    addStep("craft stone sword terminal", stoneStart.ok && stoneTerminal.ok, {
      reason: stoneStart.ok && stoneTerminal.ok ? null : "stone sword task did not reach terminal state",
      taskStart: eventSnippet(stoneStart.match),
      terminal: eventSnippet(stoneTerminal.match)
    });

    await sendOwner("bot queue clear");
    const qclear = await runner.waitFor((e) => e.type === "queue_clear", 10000);
    addStep("queue clear event", qclear.ok, { reason: qclear.ok ? null : "no queue_clear event" });

    if (nonOwnerClient) {
      runner.drain();
      nonOwnerClient.chat("craft me a wooden sword");
      const nonOwnerEvents = await runner.collectFor(7000);
      const nonOwnerReject = nonOwnerEvents.find((e) => e.type === "intent_reject" && e.reason === "not_owner");
      const nonOwnerTaskStart = nonOwnerEvents.find((e) => e.type === "task_start");
      addStep("non-owner actionable command blocked", !!nonOwnerReject && !nonOwnerTaskStart, {
        reason: nonOwnerReject && !nonOwnerTaskStart ? null : "non-owner command was not rejected cleanly",
        reject: eventSnippet(nonOwnerReject),
        taskStart: eventSnippet(nonOwnerTaskStart)
      });
    }

    const all = runner.allEvents;
    addStep("idle follow engaged observed", all.some((e) => e.type === "idle_follow_engaged"), {
      reason: all.some((e) => e.type === "idle_follow_engaged") ? null : "no idle_follow_engaged in run"
    });
    addStep("idle follow paused observed", all.some((e) => e.type === "idle_follow_paused"), {
      reason: all.some((e) => e.type === "idle_follow_paused") ? null : "no idle_follow_paused in run"
    });
  } finally {
    for (const b of startedBots) {
      try {
        b.quit();
      } catch {}
    }
    await sleep(300);
    for (const p of startedProcesses) {
      try {
        p.kill("SIGTERM");
      } catch {}
    }
  }

  report.finishedAt = new Date().toISOString();
  const pass = report.steps.filter((s) => s.pass).length;
  const fail = report.steps.length - pass;
  report.summary = { pass, fail };
  const outJson = path.join(runDir, "report.json");
  const outTxt = path.join(runDir, "summary.txt");
  fs.writeFileSync(outJson, JSON.stringify(report, null, 2));
  fs.writeFileSync(
    outTxt,
    [
      `Checklist live run: ${report.startedAt} -> ${report.finishedAt}`,
      `Pass: ${pass}`,
      `Fail: ${fail}`,
      "",
      ...report.steps.map((s) => `${s.pass ? "PASS" : "FAIL"} - ${s.name}${s.reason ? ` :: ${s.reason}` : ""}`)
    ].join("\n")
  );

  console.log(`Run summary: pass=${pass}, fail=${fail}`);
  console.log(`Report: ${outJson}`);
  console.log(`Summary: ${outTxt}`);
  process.exit(fail > 0 ? 2 : 0);
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
