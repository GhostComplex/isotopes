// Isotopes Dashboard — SPA with hash-based routing

const API_BASE = window.location.origin;
const app = document.getElementById("app");
let logInterval = null;

// Log filter state
let logFilter = {
  level: "all", // all, DEBUG, INFO, WARN, ERROR
  search: "",
};
let rawLogs = "";
let logAutoScroll = true;

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function api(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Truncate long content with expand/collapse toggle
function truncateContent(text, maxLen = 500) {
  if (!text || text.length <= maxLen) return escapeHtml(text || "");
  const id = "trunc-" + Math.random().toString(36).slice(2, 9);
  const short = escapeHtml(text.slice(0, maxLen));
  const full = escapeHtml(text);
  return `<span id="${id}-short">${short}<span class="text-muted">…</span> <a href="#" class="expand-link" onclick="event.preventDefault();document.getElementById('${id}-short').style.display='none';document.getElementById('${id}-full').style.display='inline';">[show more]</a></span><span id="${id}-full" style="display:none">${full} <a href="#" class="expand-link" onclick="event.preventDefault();document.getElementById('${id}-full').style.display='none';document.getElementById('${id}-short').style.display='inline';">[show less]</a></span>`;
}

// Detect if content contains tool_use or tool_result patterns
function isToolContent(content) {
  if (!content) return false;
  return /\btool_use\b|"type"\s*:\s*"tool_use"|"type"\s*:\s*"tool_result"|\btool_result\b/.test(content);
}

// Render a single message, collapsing tool blocks
function renderMessage(m) {
  const isTool = isToolContent(m.content);
  if (isTool) {
    const id = "tool-" + Math.random().toString(36).slice(2, 9);
    const label = m.role === "assistant" ? "Tool Call" : "Tool Result";
    return `
      <div class="message message-tool">
        <div class="message-role ${m.role}">${escapeHtml(m.role)}</div>
        <div class="tool-collapse">
          <a href="#" class="tool-toggle" onclick="event.preventDefault();var el=document.getElementById('${id}');var link=this;if(el.style.display==='none'){el.style.display='block';link.textContent='▼ ${label} (collapse)';}else{el.style.display='none';link.textContent='▶ ${label} (expand)';}">▶ ${label} (expand)</a>
          <div id="${id}" class="tool-content" style="display:none">
            <pre>${escapeHtml(m.content)}</pre>
          </div>
        </div>
        <div class="message-time">${formatDate(m.timestamp)}</div>
      </div>`;
  }

  return `
    <div class="message">
      <div class="message-role ${m.role}">${escapeHtml(m.role)}</div>
      <div class="message-content">${truncateContent(m.content)}</div>
      <div class="message-time">${formatDate(m.timestamp)}</div>
    </div>`;
}

// Format session key for display (e.g., "discord:bot:123:channel:456:main" → "discord #456 (main)")
function formatSessionKey(session) {
  if (!session.key) {
    return session.id.slice(0, 8) + '...';
  }
  // Parse key like "discord:{botId}:channel:{channelId}:{agentId}"
  const parts = session.key.split(':');
  if (parts.length >= 5 && parts[2] === 'channel') {
    const transport = parts[0];
    const channelId = parts[3];
    const agentId = parts[4] || session.agentId;
    return `${transport} #${channelId.slice(-6)} (${agentId})`;
  }
  // Fallback: truncate key
  return session.key.length > 30 ? session.key.slice(0, 30) + '...' : session.key;
}


function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
}

// ---------------------------------------------------------------------------
// Log filtering
// ---------------------------------------------------------------------------

function getLogLevel(line) {
  if (line.includes("[DEBUG]") || line.includes(" DEBUG ")) return "DEBUG";
  if (line.includes("[INFO]") || line.includes(" INFO ")) return "INFO";
  if (line.includes("[WARN]") || line.includes(" WARN ") || line.includes("[WARNING]")) return "WARN";
  if (line.includes("[ERROR]") || line.includes(" ERROR ")) return "ERROR";
  return "INFO"; // default
}

function filterLogs(logs) {
  if (!logs) return "";
  const lines = logs.split("\n");
  const filtered = lines.filter((line) => {
    // Level filter
    if (logFilter.level !== "all") {
      const lineLevel = getLogLevel(line);
      if (lineLevel !== logFilter.level) return false;
    }
    // Search filter
    if (logFilter.search) {
      if (!line.toLowerCase().includes(logFilter.search.toLowerCase())) return false;
    }
    return true;
  });
  return filtered.join("\n");
}

function updateLogDisplay() {
  const viewer = document.getElementById("log-viewer");
  if (!viewer) return;
  const filtered = filterLogs(rawLogs);

  // Render lines with level-based color classes
  if (!filtered || filtered.trim() === "") {
    viewer.innerHTML = "(no matching logs)";
  } else {
    const lines = filtered.split("\n");
    viewer.innerHTML = lines
      .map((line) => {
        const level = getLogLevel(line);
        const cls = `log-${level.toLowerCase()}`;
        return `<span class="${cls}">${escapeHtml(line)}</span>`;
      })
      .join("\n");
  }

  // Auto-scroll if enabled
  if (logAutoScroll) {
    viewer.scrollTop = viewer.scrollHeight;
  }

  // Update line count
  const countEl = document.getElementById("log-count");
  if (countEl) {
    const total = rawLogs ? rawLogs.split("\n").filter((l) => l.trim()).length : 0;
    const shown = filtered ? filtered.split("\n").filter((l) => l.trim()).length : 0;
    countEl.textContent = logFilter.level === "all" && !logFilter.search ? `${total} lines` : `${shown} / ${total} lines`;
  }
}

function onLevelChange(e) {
  logFilter.level = e.target.value;
  updateLogDisplay();
}

function onSearchChange(e) {
  logFilter.search = e.target.value;
  updateLogDisplay();
}

function onAutoScrollToggle() {
  logAutoScroll = !logAutoScroll;
  const btn = document.getElementById("log-autoscroll");
  if (btn) {
    btn.textContent = logAutoScroll ? "Auto-scroll: ON" : "Auto-scroll: OFF";
    btn.classList.toggle("active", logAutoScroll);
  }
  if (logAutoScroll) {
    const viewer = document.getElementById("log-viewer");
    if (viewer) viewer.scrollTop = viewer.scrollHeight;
  }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

async function renderStatus() {
  try {
    const [status, sessions, cron] = await Promise.all([
      api("/api/status"),
      api("/api/sessions"),
      api("/api/cron"),
    ]);

    app.innerHTML = `
      <h1>Status</h1>
      <div class="cards">
        <div class="card">
          <div class="card-label">Version</div>
          <div class="card-value">${escapeHtml(status.version)}</div>
        </div>
        <div class="card">
          <div class="card-label">Uptime</div>
          <div class="card-value">${escapeHtml(formatUptime(status.uptime))}</div>
        </div>
        <div class="card">
          <div class="card-label">Sessions</div>
          <div class="card-value">${status.sessions}</div>
        </div>
        <div class="card">
          <div class="card-label">Cron Jobs</div>
          <div class="card-value">${status.cronJobs}</div>
        </div>
      </div>
      <h1>Recent Sessions</h1>
      ${renderSessionTable(sessions.slice(0, 5))}
    `;
  } catch (err) {
    app.innerHTML = `<div class="error">Failed to load status: ${escapeHtml(err.message)}</div>`;
  }
}

function renderSessionTable(sessions) {
  if (sessions.length === 0) {
    return `<div class="loading">No sessions</div>`;
  }

  return `
    <table>
      <thead>
        <tr>
          <th>Session</th>
          <th>Agent</th>
          <th>Status</th>
          <th>Messages</th>
          <th>Last Activity</th>
        </tr>
      </thead>
      <tbody>
        ${sessions
          .map(
            (s) => `
          <tr class="clickable" onclick="location.hash='#/sessions/${s.id}'">
            <td>${escapeHtml(formatSessionKey(s))}</td>
            <td>${escapeHtml(s.agentId)}</td>
            <td><span class="badge badge-${s.status}">${escapeHtml(s.status)}</span></td>
            <td>${s.messageCount}</td>
            <td>${formatDate(s.lastActivityAt)}</td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

async function renderSessions() {
  try {
    const sessions = await api("/api/sessions");
    app.innerHTML = `
      <h1>Sessions</h1>
      ${renderSessionTable(sessions)}
    `;
  } catch (err) {
    app.innerHTML = `<div class="error">Failed to load sessions: ${escapeHtml(err.message)}</div>`;
  }
}

async function renderSessionDetail(id) {
  try {
    const session = await api(`/api/sessions/${encodeURIComponent(id)}`);

    let messages = session.history || [];
    if (messages.length === 0) {
      try {
        const data = await api(`/api/sessions/${encodeURIComponent(id)}/messages`);
        messages = data.messages || [];
      } catch (_e) {
        // messages endpoint may not exist for this session type
      }
    }

    app.innerHTML = `
      <a href="#/sessions" class="back-link">&larr; Back to sessions</a>
      <h1>Session ${escapeHtml(formatSessionKey(session))}</h1>
      <div class="cards">
        <div class="card">
          <div class="card-label">Agent</div>
          <div class="card-value" style="font-size:18px">${escapeHtml(session.agentId)}</div>
        </div>
        <div class="card">
          <div class="card-label">Status</div>
          <div class="card-value" style="font-size:18px"><span class="badge badge-${session.status}">${escapeHtml(session.status)}</span></div>
        </div>
        <div class="card">
          <div class="card-label">Created</div>
          <div class="card-value" style="font-size:14px">${formatDate(session.createdAt)}</div>
        </div>
      </div>
      <h1>Transcript (${messages.length} messages)</h1>
      <div class="transcript">
        ${
          messages.length === 0
            ? `<div class="loading">No messages</div>`
            : messages.map((m) => renderMessage(m)).join("")
        }
      </div>
    `;
  } catch (err) {
    app.innerHTML = `
      <a href="#/sessions" class="back-link">&larr; Back to sessions</a>
      <div class="error">Failed to load session: ${escapeHtml(err.message)}</div>
    `;
  }
}

async function renderCron() {
  try {
    const jobs = await api("/api/cron");
    app.innerHTML = `
      <h1>Cron Jobs</h1>
      ${
        jobs.length === 0
          ? `<div class="loading">No cron jobs configured</div>`
          : `
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Schedule</th>
                <th>Agent</th>
                <th>Status</th>
                <th>Last Run</th>
                <th>Next Run</th>
              </tr>
            </thead>
            <tbody>
              ${jobs
                .map(
                  (j) => `
                <tr>
                  <td>${escapeHtml(j.name)}</td>
                  <td><code>${escapeHtml(j.expression)}</code></td>
                  <td>${escapeHtml(j.agentId)}</td>
                  <td><span class="badge badge-${j.enabled ? "enabled" : "disabled"}">${j.enabled ? "enabled" : "disabled"}</span></td>
                  <td>${formatDate(j.lastRun)}</td>
                  <td>${formatDate(j.nextRun)}</td>
                </tr>
              `
                )
                .join("")}
            </tbody>
          </table>
        `
      }
    `;
  } catch (err) {
    app.innerHTML = `<div class="error">Failed to load cron jobs: ${escapeHtml(err.message)}</div>`;
  }
}

async function renderLogs() {
  // Reset filter state when entering logs page
  logFilter = { level: "all", search: "" };
  rawLogs = "";
  logAutoScroll = true;

  app.innerHTML = `
    <h1>Logs</h1>
    <div class="log-controls">
      <select id="log-level" class="log-select">
        <option value="all">All Levels</option>
        <option value="DEBUG">DEBUG</option>
        <option value="INFO">INFO</option>
        <option value="WARN">WARN</option>
        <option value="ERROR">ERROR</option>
      </select>
      <input type="text" id="log-search" class="log-search" placeholder="Search logs...">
      <button id="log-autoscroll" class="log-autoscroll-btn active" onclick="onAutoScrollToggle()">Auto-scroll: ON</button>
      <span id="log-count" class="log-count"></span>
    </div>
    <div class="log-viewer" id="log-viewer">Loading...</div>
  `;

  // Attach event listeners
  document.getElementById("log-level").addEventListener("change", onLevelChange);
  document.getElementById("log-search").addEventListener("input", onSearchChange);

  await refreshLogs();
  logInterval = setInterval(refreshLogs, 2000);
}

async function refreshLogs() {
  try {
    const data = await api("/api/logs?lines=200");
    rawLogs = data.logs || "";
    updateLogDisplay();
  } catch (err) {
    const viewer = document.getElementById("log-viewer");
    if (viewer) viewer.textContent = `Error loading logs: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function getRoute() {
  const hash = window.location.hash || "#/";
  return hash.slice(1) || "/";
}

async function route() {
  // Stop log polling when navigating away
  if (logInterval) {
    clearInterval(logInterval);
    logInterval = null;
  }

  const path = getRoute();

  // Update active nav link
  document.querySelectorAll(".nav-link").forEach((link) => {
    const route = link.getAttribute("data-route");
    const isActive =
      (route === "status" && (path === "/" || path === "")) ||
      (route === "sessions" && path.startsWith("/sessions")) ||
      (route === "cron" && path === "/cron") ||
      (route === "logs" && path === "/logs");
    link.classList.toggle("active", isActive);
  });

  // Session detail route
  const sessionMatch = path.match(/^\/sessions\/(.+)$/);
  if (sessionMatch) {
    await renderSessionDetail(sessionMatch[1]);
    return;
  }

  switch (path) {
    case "/":
    case "":
      await renderStatus();
      break;
    case "/sessions":
      await renderSessions();
      break;
    case "/cron":
      await renderCron();
      break;
    case "/logs":
      await renderLogs();
      break;
    default:
      app.innerHTML = `<div class="error">Page not found</div>`;
  }
}

window.addEventListener("hashchange", route);
route();
