const fs = require("fs");
const path = require("path");
const os = require("os");
const express = require("express");
const chokidar = require("chokidar");

// ─── Session State ───────────────────────────────────────────────────────────

const sessions = new Map();
const fileOffsets = new Map();
const seenMessageIds = new Map();

function getOrCreate(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sessionId,
      cwd: "",
      label: "",
      sessionName: "", // custom title set via /name command
      model: "",
      gitBranch: "",
      lastAction: null,   // { type, summary, timestamp }
      lastResponse: null,  // { text, timestamp }
      lastUserMessage: null, // { text, timestamp }
      status: "idle",
      lastEventAt: null,
      startedAt: null,
      turnCount: 0,
      tokensOut: 0,
      costUSD: 0,
      permissionMode: "",
      lastSpeaker: null, // "user" or "assistant"
      lastSpeakerAt: null,
      lastAssistantHadToolUse: false,
      lastAssistantHadText: false,
      lastStopReason: null,
      lastActivityType: null, // "progress", "tool-result", "agent-working"
      lastActivityAt: null,
    });
    seenMessageIds.set(sessionId, new Map());
  }
  return sessions.get(sessionId);
}

// ─── Pricing ─────────────────────────────────────────────────────────────────

const PRICING = {
  "claude-opus-4": { input: 15.0, output: 75.0 },
  "claude-sonnet-4": { input: 3.0, output: 15.0 },
  "claude-haiku-4": { input: 0.8, output: 4.0 },
};

function getPricing(model) {
  if (!model) return PRICING["claude-sonnet-4"];
  for (const [key, val] of Object.entries(PRICING)) {
    if (model.includes(key)) return val;
  }
  return PRICING["claude-sonnet-4"];
}

// ─── Event Processing ────────────────────────────────────────────────────────

function processEvent(event) {
  if (!event || !event.sessionId) return;
  // Handle custom-title events (no timestamp required)
  if (event.type === "custom-title" && event.customTitle) {
    const session = getOrCreate(event.sessionId);
    session.sessionName = event.customTitle;
    return;
  }
  if (!event.timestamp) return;
  if (["file-history-snapshot", "queue-operation", "last-prompt"].includes(event.type)) return;

  const session = getOrCreate(event.sessionId);
  const ts = event.timestamp;

  if (!session.startedAt) session.startedAt = ts;
  session.lastEventAt = ts;

  // Project info
  if (event.cwd && !session.cwd) {
    session.cwd = event.cwd;
    const parts = event.cwd.split("/").filter(Boolean);
    session.label = parts.slice(-2).join("/");
  }
  if (event.gitBranch) session.gitBranch = event.gitBranch;
  if (event.permissionMode) session.permissionMode = event.permissionMode;

  // Track progress events — Claude or sub-agents are actively working
  if (event.type === "progress") {
    session.lastActivityType = "progress";
    session.lastActivityAt = ts;
  }

  const msg = event.message || {};
  const content = msg.content;

  // ── User messages: capture what the user asked ──
  if (event.type === "user" && msg.role === "user") {
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
        ? content.find((c) => c.type === "text")?.text || ""
        : "";
    if (text && !event.agentId) {
      session.lastUserMessage = {
        text: text.substring(0, 300),
        timestamp: ts,
      };
      session.lastSpeaker = "user";
      session.lastSpeakerAt = ts;
    }
    // Tool results (from user role but no text) mean Claude is mid-cycle
    if (!text && !event.agentId) {
      session.lastActivityType = "tool-result";
      session.lastActivityAt = ts;
    }
  }

  // ── Assistant messages (from sub-agents) — track as activity ──
  if (event.type === "assistant" && event.agentId) {
    session.lastActivityType = "agent-working";
    session.lastActivityAt = ts;
  }

  // ── Assistant messages: capture last action + last response ──
  if (event.type === "assistant" && msg.usage && !event.agentId) {
    if (msg.model) session.model = msg.model;

    // Token tracking (delta-based)
    const msgId = msg.id;
    const usage = msg.usage;
    const seen = seenMessageIds.get(event.sessionId);
    const prev = seen.get(msgId) || { out: 0, in: 0, cacheCreate: 0, cacheRead: 0 };
    const curr = {
      out: usage.output_tokens || 0,
      in: usage.input_tokens || 0,
      cacheCreate: usage.cache_creation_input_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
    };
    session.tokensOut += Math.max(0, curr.out - prev.out);
    const tokensIn = (curr.in - prev.in) + (curr.cacheCreate - prev.cacheCreate) + (curr.cacheRead - prev.cacheRead);
    seen.set(msgId, curr);

    const pricing = getPricing(session.model);
    session.costUSD =
      ((curr.in) * pricing.input) / 1_000_000 +
      session.tokensOut * (pricing.output / 1_000_000);

    if (msg.stop_reason) session.turnCount++;
    session.lastStopReason = msg.stop_reason || null;

    session.lastSpeaker = "assistant";
    session.lastSpeakerAt = ts;

    if (Array.isArray(content)) {
      session.lastAssistantHadToolUse = content.some((c) => c.type === "tool_use");
      session.lastAssistantHadText = content.some((c) => c.type === "text" && c.text);

      // Find the last tool_use block → that's the "last action"
      const toolBlocks = content.filter((c) => c.type === "tool_use");
      if (toolBlocks.length > 0) {
        const last = toolBlocks[toolBlocks.length - 1];
        let summary = last.name;
        if (last.input) {
          if (last.input.file_path) summary += `: ${path.basename(last.input.file_path)}`;
          else if (last.input.path) summary += `: ${path.basename(last.input.path)}`;
          else if (last.input.command) {
            const cmd = last.input.command.substring(0, 80);
            summary += `: ${cmd}`;
          }
          else if (last.input.pattern) summary += `: ${last.input.pattern}`;
        }
        session.lastAction = { type: "tool", summary, timestamp: ts };
      }

      // Find the last text block → that's the "last response"
      const textBlocks = content.filter((c) => c.type === "text" && c.text);
      if (textBlocks.length > 0) {
        const last = textBlocks[textBlocks.length - 1];
        session.lastResponse = {
          text: last.text.substring(0, 500),
          timestamp: ts,
        };
      }
    }
  }
}

// ─── Status Derivation ───────────────────────────────────────────────────────
//
// Statuses:
//   "active"        → Claude is currently working (< 30s since last event)
//   "needs-input"   → Claude responded with text, waiting for YOU to act
//   "ready-to-read" → Claude finished and left a response you haven't seen
//   "your-turn"     → You sent a message but Claude hasn't responded yet (stuck?)
//   "idle"          → No activity for a while

function deriveStatus(session, isAlive) {
  // CLI is no longer running → session is done, hide it
  if (!isAlive) return "idle";

  // No events yet but terminal is open → waiting for first prompt
  if (!session.lastEventAt) return "needs-input";

  const now = Date.now();
  const elapsed = now - new Date(session.lastEventAt).getTime();

  // Recent activity from progress events, sub-agents, or tool results → actively working
  const activityElapsed = session.lastActivityAt
    ? now - new Date(session.lastActivityAt).getTime()
    : Infinity;
  if (activityElapsed < 30_000) return "active";

  // Last event was very recent → actively working
  if (elapsed < 30_000) return "active";

  // ── Who spoke last? ──
  if (session.lastSpeaker === "assistant") {
    // Claude's last response ended with tool_use → mid-cycle, likely waiting for permission
    if (session.lastStopReason === "tool_use") {
      return "needs-input";
    }
    // Claude responded with text → you need to read/act
    if (session.lastAssistantHadText) {
      return elapsed > 300_000 ? "ready-to-read" : "needs-input";
    }
    // Claude only used tools, no text
    return elapsed > 300_000 ? "ready-to-read" : "needs-input";
  }

  if (session.lastSpeaker === "user") {
    // You said something but Claude hasn't responded
    return "your-turn";
  }

  // lastSpeaker is null — session exists but we couldn't determine who spoke last
  if (session.lastActivityType === "agent-working" || session.lastActivityType === "progress") {
    return elapsed > 300_000 ? "ready-to-read" : "needs-input";
  }

  // Terminal is open — always show it
  return "needs-input";
}

// ─── Active Session Detection ────────────────────────────────────────────────
// Claude Code writes a PID file to ~/.claude/sessions/<pid>.json for each
// running instance. When the CLI exits, the file is removed. We read these
// to know which sessions are still alive.

function getAliveSessionIds() {
  const sessionsDir = path.join(os.homedir(), ".claude", "sessions");
  const alive = new Map(); // sessionId → { cwd, pid }
  try {
    const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), "utf8"));
        if (data.sessionId) alive.set(data.sessionId, { cwd: data.cwd, pid: data.pid });
      } catch {}
    }
  } catch {}
  return alive;
}

// ─── File Watching ───────────────────────────────────────────────────────────

function processFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }
  const offset = fileOffsets.get(filePath) || 0;
  if (stat.size <= offset) return;

  const stream = fs.createReadStream(filePath, { start: offset, encoding: "utf8" });
  let buffer = "";

  stream.on("data", (chunk) => (buffer += chunk));
  stream.on("end", () => {
    fileOffsets.set(filePath, stat.size);
    for (const line of buffer.split("\n")) {
      if (!line.trim()) continue;
      try {
        processEvent(JSON.parse(line));
      } catch {}
    }
  });
}

function shouldProcess(fp) {
  return fp.endsWith(".jsonl") && !path.basename(fp).includes("compact");
}

// ─── Express Server ──────────────────────────────────────────────────────────

const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/sessions", (req, res) => {
  const results = [];
  const aliveIds = getAliveSessionIds();

  // Ensure all alive sessions exist in the map (even if JSONL wasn't found yet)
  for (const [sid, meta] of aliveIds.entries()) {
    if (!sessions.has(sid)) {
      const session = getOrCreate(sid);
      if (meta.cwd) {
        session.cwd = meta.cwd;
        const parts = meta.cwd.split("/").filter(Boolean);
        session.label = parts.slice(-2).join("/");
      }
    }
  }

  for (const session of sessions.values()) {
    const isAlive = aliveIds.has(session.sessionId);
    const status = deriveStatus(session, isAlive);

    // Hide idle sessions entirely — only show sessions that need attention
    if (status === "idle") continue;

    results.push({
      sessionId: session.sessionId,
      label: session.label,
      sessionName: session.sessionName,
      cwd: session.cwd,
      model: session.model,
      gitBranch: session.gitBranch,
      status,
      lastAction: session.lastAction,
      lastResponse: session.lastResponse,
      lastUserMessage: session.lastUserMessage,
      lastEventAt: session.lastEventAt,
      startedAt: session.startedAt,
      turnCount: session.turnCount,
      costUSD: Math.round(session.costUSD * 10000) / 10000,
      permissionMode: session.permissionMode,
      lastSpeaker: session.lastSpeaker,
    });
  }

  // Sort: active first, then actionable, then idle
  results.sort((a, b) => {
    const order = { active: 0, "needs-input": 1, "your-turn": 2, "ready-to-read": 3, idle: 4 };
    const diff = (order[a.status] ?? 3) - (order[b.status] ?? 3);
    if (diff !== 0) return diff;
    return new Date(b.lastEventAt || 0) - new Date(a.lastEventAt || 0);
  });

  res.json(results);
});

app.get("/api/debug", (req, res) => {
  const aliveIds = getAliveSessionIds();
  const sessionsDir = path.join(os.homedir(), ".claude", "sessions");

  // Read raw PID files
  let pidFiles = [];
  try {
    pidFiles = fs.readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), "utf8"));
          return { file: f, pid: data.pid, sessionId: data.sessionId, cwd: data.cwd };
        } catch (e) {
          return { file: f, error: e.message };
        }
      });
  } catch (e) {
    pidFiles = [{ error: e.message, dir: sessionsDir }];
  }

  // All sessions from JSONL parsing
  const allSessions = [];
  for (const session of sessions.values()) {
    const isAlive = aliveIds.has(session.sessionId);
    allSessions.push({
      sessionId: session.sessionId,
      label: session.label,
      sessionName: session.sessionName,
      isAlive,
      status: deriveStatus(session, isAlive),
      lastSpeaker: session.lastSpeaker,
      lastEventAt: session.lastEventAt,
    });
  }

  res.json({
    homeDir: os.homedir(),
    sessionsDir,
    pidFileCount: pidFiles.length,
    pidFiles,
    aliveSessionIds: [...aliveIds.keys()],
    totalSessionsInMap: sessions.size,
    allSessions,
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────

const WATCH_DIR = path.join(os.homedir(), ".claude", "projects");
const PORT = process.env.PORT || 3200;

if (!fs.existsSync(WATCH_DIR)) {
  console.log(`Creating watch directory: ${WATCH_DIR}`);
  fs.mkdirSync(WATCH_DIR, { recursive: true });
}

console.log(`\n  🖥️  Claude Terminal Board`);
console.log(`  Watching: ${WATCH_DIR}`);
console.log(`  Dashboard: http://localhost:${PORT}\n`);

const watcher = chokidar.watch(WATCH_DIR, {
  persistent: true,
  ignoreInitial: false,
  depth: 4,
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
});

watcher.on("add", (fp) => shouldProcess(fp) && processFile(fp));
watcher.on("change", (fp) => shouldProcess(fp) && processFile(fp));

app.listen(PORT, () => {
  console.log(`  Server ready on port ${PORT}\n`);
});
