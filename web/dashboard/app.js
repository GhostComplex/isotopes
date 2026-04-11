// Isotopes Dashboard — SPA with hash-based routing

const API_BASE = window.location.origin;
const app = document.getElementById("app");
let logInterval = null;

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
          <th>ID</th>
          <th>Agent</th>
          <th>Status</th>
          <th>Messages</th>
          <th>Last Activity</th>
        </tr>
      </thead>
      <tbody>
        ${sessions.map(s => `
          <tr class="clickable" onclick="location.hash='#/sessions/${s.id}'">
            <td>${escapeHtml(s.id.slice(0, 8))}...</td>
            <td>${escapeHtml(s.agentId)}</td>
            <td><span class="badge badge-${s.status}">${escapeHtml(s.status)}</span></td>
            <td>${s.messageCount}</td>
            <td>${formatDate(s.lastActivityAt)}</td>
          </tr>
        `).join("")}
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
    app.innerHTML = `
      <a href="#/sessions" class="back-link">&larr; Back to sessions</a>
      <h1>Session ${escapeHtml(session.id.slice(0, 8))}...</h1>
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
      <h1>Transcript</h1>
      <div class="transcript">
        ${session.history.length === 0
          ? `<div class="loading">No messages</div>`
          : session.history.map(m => `
            <div class="message">
              <div class="message-role ${m.role}">${escapeHtml(m.role)}</div>
              <div class="message-content">${escapeHtml(m.content)}</div>
              <div class="message-time">${formatDate(m.timestamp)}</div>
            </div>
          `).join("")}
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
      ${jobs.length === 0
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
              ${jobs.map(j => `
                <tr>
                  <td>${escapeHtml(j.name)}</td>
                  <td><code>${escapeHtml(j.expression)}</code></td>
                  <td>${escapeHtml(j.agentId)}</td>
                  <td><span class="badge badge-${j.enabled ? "enabled" : "disabled"}">${j.enabled ? "enabled" : "disabled"}</span></td>
                  <td>${formatDate(j.lastRun)}</td>
                  <td>${formatDate(j.nextRun)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        `}
    `;
  } catch (err) {
    app.innerHTML = `<div class="error">Failed to load cron jobs: ${escapeHtml(err.message)}</div>`;
  }
}

async function renderLogs() {
  app.innerHTML = `
    <h1>Logs</h1>
    <div class="log-viewer" id="log-viewer">Loading...</div>
  `;
  await refreshLogs();
  logInterval = setInterval(refreshLogs, 2000);
}

async function refreshLogs() {
  try {
    const data = await api("/api/logs?lines=200");
    const viewer = document.getElementById("log-viewer");
    if (!viewer) return;
    viewer.textContent = data.logs || "(no logs)";
    viewer.scrollTop = viewer.scrollHeight;
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
  document.querySelectorAll(".nav-link").forEach(link => {
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
