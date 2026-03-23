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
      userMessages: [],     // all user messages: [{ text, timestamp }]
      toolsUsed: new Set(), // all tool names used in this session
      filesChanged: new Set(), // files edited/written
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
      // Track all user messages for worklog
      session.userMessages.push({ text: text.substring(0, 500), timestamp: ts });
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

      // Track all tools used and files changed for worklog
      for (const block of toolBlocks) {
        session.toolsUsed.add(block.name);
        if (block.input) {
          const fp = block.input.file_path || block.input.path;
          if (fp && (block.name === "Edit" || block.name === "Write" || block.name === "NotebookEdit")) {
            session.filesChanged.add(path.basename(fp));
          }
        }
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
  // CLI is no longer running → session is done
  if (!isAlive) return "idle";

  const now = Date.now();

  // No JSONL events at all but process is running → waiting for first prompt
  if (!session.lastEventAt) return "needs-input";

  const elapsed = now - new Date(session.lastEventAt).getTime();

  // Process is alive but no activity for a very long time → still show it but as "ready-to-read"
  // (Don't hide alive sessions — the user left them open for a reason)
  if (elapsed > 10_800_000) return "ready-to-read";

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

  // Fallback: has events but unclear state
  return elapsed > 300_000 ? "ready-to-read" : "needs-input";
}

// ─── Active Session Detection ────────────────────────────────────────────────
// Claude Code writes a PID file to ~/.claude/sessions/<pid>.json for each
// running instance. When the CLI exits, the file is removed. We read these
// to know which sessions are still alive.

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0); // signal 0 = just check if process exists
    return true;
  } catch {
    return false; // ESRCH = no such process
  }
}

// Find the actual project directory in ~/.claude/projects/ that matches a cwd.
// Instead of computing the encoding, scan the real directories and match.
function findProjectDir(cwd) {
  if (!cwd) return null;
  const projectsDir = path.join(os.homedir(), ".claude", "projects");

  // Strategy 1: try the expected encoding (replace / and . with -)
  const expected = "-" + cwd.split("/").filter(Boolean).join("-").replace(/\./g, "-");
  const expectedPath = path.join(projectsDir, expected);
  try {
    if (fs.statSync(expectedPath).isDirectory()) return expected;
  } catch {}

  // Strategy 2: scan all directories and find one whose name matches when decoded
  // The cwd components should appear in the directory name
  const cwdParts = cwd.split("/").filter(Boolean);
  const lastPart = cwdParts[cwdParts.length - 1];
  if (!lastPart) return null;

  try {
    const dirs = fs.readdirSync(projectsDir);
    // Look for dirs ending with the last component (with dots replaced by dashes)
    const lastPartEncoded = lastPart.replace(/\./g, "-");
    const match = dirs.find((d) => d.endsWith("-" + lastPartEncoded) || d.endsWith("-" + lastPart));
    if (match) {
      try {
        if (fs.statSync(path.join(projectsDir, match)).isDirectory()) return match;
      } catch {}
    }

    // Strategy 3: look for dirs that contain all cwd parts (more fuzzy)
    for (const d of dirs) {
      const dLower = d.toLowerCase();
      const allMatch = cwdParts.every((p) => dLower.includes(p.toLowerCase().replace(/\./g, "-")));
      if (allMatch) {
        try {
          if (fs.statSync(path.join(projectsDir, d)).isDirectory()) return d;
        } catch {}
      }
    }
  } catch {}

  return null;
}

// For a given project directory, find recently modified JSONL files
// Uses openSync/fstatSync to bypass macOS stat caching
function getRecentJsonlSessionIds(projectDirName, maxAge) {
  const dirPath = path.join(os.homedir(), ".claude", "projects", projectDirName);
  const results = [];
  try {
    const files = fs.readdirSync(dirPath).filter(
      (f) => f.endsWith(".jsonl") && !f.includes("compact")
    );
    for (const file of files) {
      try {
        // Use openSync/fstatSync to bypass macOS stat caching
        const fd = fs.openSync(path.join(dirPath, file), "r");
        const stat = fs.fstatSync(fd);
        fs.closeSync(fd);
        const age = Date.now() - stat.mtimeMs;
        if (age < maxAge) {
          const sid = file.replace(".jsonl", "");
          results.push({ sid, mtime: stat.mtimeMs });
        }
      } catch {}
    }
  } catch {}
  // Sort by most recent first
  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

function getAliveSessionIds() {
  const sessionsDir = path.join(os.homedir(), ".claude", "sessions");
  const alive = new Map(); // sessionId → { cwd, pid }

  // Read all PID files for running processes
  const alivePids = []; // { pid, sessionId, cwd }
  try {
    const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), "utf8"));
        if (data.sessionId && data.pid && isProcessRunning(data.pid)) {
          alivePids.push({ pid: data.pid, sessionId: data.sessionId, cwd: data.cwd });
          alive.set(data.sessionId, { cwd: data.cwd, pid: data.pid });
        }
      } catch {}
    }
  } catch {}

  // For each alive PID, find the real project directory and check for
  // recently modified JSONL files with different sessionIds (resumed sessions)
  for (const pidInfo of alivePids) {
    const projDir = findProjectDir(pidInfo.cwd);
    if (!projDir) continue;

    const recentFiles = getRecentJsonlSessionIds(projDir, 10_800_000); // 3 hours

    // Check if the PID's own sessionId has a JSONL file (at any age, not just recent)
    const dirPath = path.join(os.homedir(), ".claude", "projects", projDir);
    const pidJsonlExists = fs.existsSync(path.join(dirPath, pidInfo.sessionId + ".jsonl"));

    if (!pidJsonlExists) {
      // This PID has no JSONL file of its own — it's likely a resumed session.
      // Find the most recently modified JSONL that isn't already claimed by another PID.
      // recentFiles is sorted by mtime desc, so first unclaimed match wins.
      let foundReplacement = false;
      for (const { sid } of recentFiles) {
        if (sid !== pidInfo.sessionId && !alive.has(sid)) {
          alive.set(sid, { cwd: pidInfo.cwd, pid: pidInfo.pid, resumedFrom: pidInfo.sessionId });
          foundReplacement = true;
          break; // only claim one JSONL per PID
        }
      }
      // Only remove the blank PID entry if we found a JSONL to replace it with.
      // If no replacement found, keep it — it's either a brand new session or
      // the JSONL matching couldn't find the right file yet.
      if (foundReplacement) {
        alive.delete(pidInfo.sessionId);
      }
    }
  }

  return alive;
}

// ─── File Watching ───────────────────────────────────────────────────────────

function processFile(filePath) {
  // Open the file descriptor directly to bypass any OS stat caching
  let fd, size;
  try {
    fd = fs.openSync(filePath, "r");
    size = fs.fstatSync(fd).size;
    fs.closeSync(fd);
  } catch {
    return;
  }
  const offset = fileOffsets.get(filePath) || 0;
  if (size <= offset) return;

  try {
    const buf = Buffer.alloc(size - offset);
    const fd2 = fs.openSync(filePath, "r");
    fs.readSync(fd2, buf, 0, buf.length, offset);
    fs.closeSync(fd2);
    fileOffsets.set(filePath, size);

    const text = buf.toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        processEvent(JSON.parse(line));
      } catch {}
    }
  } catch {}
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

  // Ensure all alive sessions exist in the map (even if JSONL wasn't found)
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

    const aliveMeta = aliveIds.get(session.sessionId);
    results.push({
      sessionId: session.sessionId,
      pid: aliveMeta?.pid || null,
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

app.post("/api/kill/:pid", (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  if (!pid || isNaN(pid)) return res.status(400).json({ error: "Invalid PID" });

  try {
    if (!isProcessRunning(pid)) {
      return res.json({ success: true, message: "Process already stopped" });
    }
    // Send SIGTERM (graceful shutdown)
    process.kill(pid, "SIGTERM");
    // Give it a moment, then check if it's still running
    setTimeout(() => {
      try {
        if (isProcessRunning(pid)) {
          // Still running after SIGTERM, force kill
          process.kill(pid, "SIGKILL");
        }
      } catch {}
    }, 2000);
    res.json({ success: true, message: `Sent SIGTERM to PID ${pid}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Worklog API ──────────────────────────────────────────────────────────
// Returns session data grouped by date and project for timesheet/worklog view.
// Query params: ?days=7 (default 7, max 30)

app.get("/api/worklog", (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 30);
  const cutoff = Date.now() - days * 86_400_000;

  // Group sessions by date
  const dayMap = new Map(); // "YYYY-MM-DD" → [entries]

  for (const session of sessions.values()) {
    if (!session.startedAt && !session.lastEventAt) continue;
    const startMs = new Date(session.startedAt || session.lastEventAt).getTime();
    const endMs = new Date(session.lastEventAt || session.startedAt).getTime();
    if (endMs < cutoff) continue;

    const dateKey = new Date(startMs).toISOString().split("T")[0];
    if (!dayMap.has(dateKey)) dayMap.set(dateKey, []);

    // Calculate active duration (wall-clock from first to last event)
    const durationMs = Math.max(0, endMs - startMs);

    // Extract project name from cwd
    const cwdParts = (session.cwd || "").split("/").filter(Boolean);
    const project = cwdParts[cwdParts.length - 1] || session.label || "Onbekend";

    // Build task summary from user messages
    const tasks = session.userMessages
      .filter((m) => m.text && m.text.length > 5)
      .map((m) => ({
        text: m.text,
        time: new Date(m.timestamp).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" }),
      }));

    dayMap.get(dateKey).push({
      sessionId: session.sessionId,
      sessionName: session.sessionName || null,
      project,
      label: session.label,
      model: session.model,
      startedAt: session.startedAt,
      lastEventAt: session.lastEventAt,
      durationMs,
      turnCount: session.turnCount,
      costUSD: Math.round(session.costUSD * 10000) / 10000,
      tasks,
      toolsUsed: [...session.toolsUsed],
      filesChanged: [...session.filesChanged],
    });
  }

  // Sort days descending, sessions within day by start time
  const result = [];
  const sortedDays = [...dayMap.keys()].sort((a, b) => b.localeCompare(a));
  for (const date of sortedDays) {
    const entries = dayMap.get(date).sort(
      (a, b) => new Date(a.startedAt || 0) - new Date(b.startedAt || 0)
    );
    const totalDuration = entries.reduce((s, e) => s + e.durationMs, 0);
    const totalCost = entries.reduce((s, e) => s + e.costUSD, 0);
    const totalTurns = entries.reduce((s, e) => s + e.turnCount, 0);

    // Group entries by project
    const projectMap = new Map();
    for (const entry of entries) {
      if (!projectMap.has(entry.project)) projectMap.set(entry.project, []);
      projectMap.get(entry.project).push(entry);
    }
    const projects = [...projectMap.entries()].map(([name, sessions]) => ({
      name,
      sessions,
      totalDuration: sessions.reduce((s, e) => s + e.durationMs, 0),
      totalCost: sessions.reduce((s, e) => s + e.costUSD, 0),
      totalTurns: sessions.reduce((s, e) => s + e.turnCount, 0),
    }));

    result.push({
      date,
      totalDuration,
      totalCost: Math.round(totalCost * 10000) / 10000,
      totalTurns,
      sessionCount: entries.length,
      projects,
    });
  }

  res.json(result);
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
          const running = isProcessRunning(data.pid);
          const projDir = running ? findProjectDir(data.cwd) : null;
          let hasOwnJsonl = false;
          let recentJsonls = [];
          if (projDir) {
            const dp = path.join(os.homedir(), ".claude", "projects", projDir);
            hasOwnJsonl = fs.existsSync(path.join(dp, data.sessionId + ".jsonl"));
            recentJsonls = getRecentJsonlSessionIds(projDir, 10_800_000).map((r) => r.sid.substring(0, 8));
          }
          return {
            file: f, pid: data.pid, sessionId: data.sessionId.substring(0, 8),
            cwd: data.cwd, processRunning: running,
            matchedProjectDir: projDir, hasOwnJsonl,
            recentJsonlsInDir: recentJsonls,
          };
        } catch (e) {
          return { file: f, error: e.message };
        }
      });
  } catch (e) {
    pidFiles = [{ error: e.message, dir: sessionsDir }];
  }

  // Show what project directories exist
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  let allProjectDirs = [];
  try {
    allProjectDirs = fs.readdirSync(projectsDir).filter((d) => {
      try { return fs.statSync(path.join(projectsDir, d)).isDirectory(); } catch { return false; }
    });
  } catch {}

  // All sessions from JSONL parsing
  const allSessions = [];
  for (const session of sessions.values()) {
    const isAlive = aliveIds.has(session.sessionId);
    const aliveInfo = aliveIds.get(session.sessionId);
    allSessions.push({
      sessionId: session.sessionId,
      label: session.label,
      sessionName: session.sessionName,
      isAlive,
      resumedFrom: aliveInfo?.resumedFrom || null,
      status: deriveStatus(session, isAlive),
      lastSpeaker: session.lastSpeaker,
      lastEventAt: session.lastEventAt,
      turnCount: session.turnCount,
    });
  }

  res.json({
    homeDir: os.homedir(),
    sessionsDir,
    pidFileCount: pidFiles.length,
    pidFiles: pidFiles.filter((p) => p.processRunning),
    allProjectDirs,
    aliveSessionIds: [...aliveIds.entries()].map(([sid, meta]) => ({
      sessionId: sid,
      cwd: meta.cwd,
      resumedFrom: meta.resumedFrom || null,
    })),
    totalSessionsInMap: sessions.size,
    allSessions: allSessions.filter((s) => s.status !== "idle"),
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

// ─── Periodic Scan ──────────────────────────────────────────────────────────
// chokidar misses file changes on macOS. Every 3 seconds, scan project dirs
// that have alive PIDs and re-read any JSONL files that have grown.

function periodicScan() {
  const aliveIds = getAliveSessionIds();
  if (aliveIds.size === 0) return;

  // Collect unique project dir names for alive sessions
  const projectDirs = new Set();
  for (const [, meta] of aliveIds) {
    const dir = findProjectDir(meta.cwd);
    if (dir) projectDirs.add(dir);
  }

  // Scan each project dir and process all JSONL files
  for (const dir of projectDirs) {
    const dirPath = path.join(WATCH_DIR, dir);
    try {
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        if (file.endsWith(".jsonl") && !file.includes("compact")) {
          processFile(path.join(dirPath, file));
        }
        // Also check session subdirectories (subagents)
        const subPath = path.join(dirPath, file);
        try {
          if (fs.statSync(subPath).isDirectory()) {
            // Direct JSONL in session folder
            for (const sf of fs.readdirSync(subPath)) {
              if (sf.endsWith(".jsonl") && !sf.includes("compact")) {
                processFile(path.join(subPath, sf));
              }
            }
            // Subagents folder
            const agentsDir = path.join(subPath, "subagents");
            try {
              for (const af of fs.readdirSync(agentsDir)) {
                if (af.endsWith(".jsonl") && !af.includes("compact")) {
                  processFile(path.join(agentsDir, af));
                }
              }
            } catch {}
          }
        } catch {}
      }
    } catch {}
  }
}

setInterval(periodicScan, 3000);

app.listen(PORT, () => {
  console.log(`  Server ready on port ${PORT}\n`);
});
