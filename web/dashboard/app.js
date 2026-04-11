// Isotopes Dashboard — Vanilla SPA

const API_BASE = '/api';

// Router
class Router {
  constructor(routes) {
    this.routes = routes;
    window.addEventListener('hashchange', () => this.navigate());
    window.addEventListener('load', () => this.navigate());
  }

  navigate() {
    const hash = window.location.hash || '#/';
    const path = hash.slice(1);
    
    // Update active nav link
    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.remove('active');
      if (link.getAttribute('href') === hash) {
        link.classList.add('active');
      }
    });

    // Find matching route
    for (const [pattern, handler] of Object.entries(this.routes)) {
      const regex = new RegExp(`^${pattern.replace(/:\w+/g, '([^/]+)')}$`);
      const match = path.match(regex);
      if (match) {
        const params = match.slice(1);
        handler(...params);
        return;
      }
    }
    
    // 404
    this.render('<div class="loading">Page not found</div>');
  }

  render(html) {
    document.getElementById('page-content').innerHTML = html;
  }
}

// API helpers
async function api(endpoint) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`API error: ${endpoint}`, err);
    throw err;
  }
}

// Format helpers
function timeAgo(date) {
  const seconds = Math.floor((Date.now() - new Date(date)) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Pages
async function renderHome() {
  const content = document.getElementById('page-content');
  content.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const status = await api('/status');
    
    content.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Dashboard</h1>
        <p class="page-subtitle">System overview</p>
      </div>
      
      <div class="card-grid">
        <div class="card">
          <div class="card-title">Status</div>
          <div class="card-value online">● Online</div>
        </div>
        <div class="card">
          <div class="card-title">Uptime</div>
          <div class="card-value">${formatDuration(status.uptime)}</div>
        </div>
        <div class="card">
          <div class="card-title">Active Sessions</div>
          <div class="card-value">${status.sessions || 0}</div>
        </div>
        <div class="card">
          <div class="card-title">Cron Jobs</div>
          <div class="card-value">${status.cronJobs || 0}</div>
        </div>
      </div>

      <h2 style="margin-bottom: 16px;">Quick Links</h2>
      <div class="card-grid">
        <a href="#/sessions" class="card" style="text-decoration: none;">
          <div class="card-title">💬 Sessions</div>
          <p style="color: var(--text-secondary);">View conversation history</p>
        </a>
        <a href="#/cron" class="card" style="text-decoration: none;">
          <div class="card-title">⏰ Cron Jobs</div>
          <p style="color: var(--text-secondary);">Scheduled tasks</p>
        </a>
        <a href="#/logs" class="card" style="text-decoration: none;">
          <div class="card-title">📜 Logs</div>
          <p style="color: var(--text-secondary);">Real-time system logs</p>
        </a>
      </div>
    `;
  } catch (err) {
    content.innerHTML = `<div class="loading">Error loading status: ${err.message}</div>`;
  }
}

async function renderSessions() {
  const content = document.getElementById('page-content');
  content.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const sessions = await api('/sessions');
    
    if (!sessions || sessions.length === 0) {
      content.innerHTML = `
        <div class="page-header">
          <h1 class="page-title">Sessions</h1>
          <p class="page-subtitle">Conversation history</p>
        </div>
        <div class="loading">No sessions found</div>
      `;
      return;
    }

    const rows = sessions.map(s => `
      <tr>
        <td><a href="#/sessions/${s.id}">${s.id.slice(0, 8)}...</a></td>
        <td>${s.agent || '-'}</td>
        <td>${s.channel || '-'}</td>
        <td>${s.messageCount || 0}</td>
        <td>${s.lastActive ? timeAgo(s.lastActive) : '-'}</td>
      </tr>
    `).join('');

    content.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Sessions</h1>
        <p class="page-subtitle">${sessions.length} total sessions</p>
      </div>
      
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Session ID</th>
              <th>Agent</th>
              <th>Channel</th>
              <th>Messages</th>
              <th>Last Active</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    content.innerHTML = `<div class="loading">Error loading sessions: ${err.message}</div>`;
  }
}

async function renderSessionDetail(sessionId) {
  const content = document.getElementById('page-content');
  content.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const session = await api(`/sessions/${sessionId}`);
    
    const messages = (session.history || []).map(msg => `
      <div class="message">
        <div class="message-role ${msg.role}">${msg.role}</div>
        <div class="message-content">${escapeHtml(msg.content || '')}</div>
      </div>
    `).join('');

    content.innerHTML = `
      <a href="#/sessions" class="back-link">← Back to Sessions</a>
      
      <div class="page-header">
        <h1 class="page-title">Session ${sessionId.slice(0, 8)}...</h1>
        <p class="page-subtitle">${session.history?.length || 0} messages</p>
      </div>
      
      <div class="transcript">
        ${messages || '<p style="color: var(--text-secondary);">No messages</p>'}
      </div>
    `;
  } catch (err) {
    content.innerHTML = `
      <a href="#/sessions" class="back-link">← Back to Sessions</a>
      <div class="loading">Error loading session: ${err.message}</div>
    `;
  }
}

async function renderCron() {
  const content = document.getElementById('page-content');
  content.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const jobs = await api('/cron');
    
    if (!jobs || jobs.length === 0) {
      content.innerHTML = `
        <div class="page-header">
          <h1 class="page-title">Cron Jobs</h1>
          <p class="page-subtitle">Scheduled tasks</p>
        </div>
        <div class="loading">No cron jobs configured</div>
      `;
      return;
    }

    const rows = jobs.map(job => `
      <tr>
        <td>${escapeHtml(job.name || job.id)}</td>
        <td><code>${escapeHtml(job.schedule)}</code></td>
        <td><span class="badge ${job.enabled ? 'badge-success' : 'badge-warning'}">${job.enabled ? 'Enabled' : 'Disabled'}</span></td>
        <td>${job.lastRun ? timeAgo(job.lastRun) : '-'}</td>
        <td>${job.nextRun || '-'}</td>
      </tr>
    `).join('');

    content.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Cron Jobs</h1>
        <p class="page-subtitle">${jobs.length} scheduled tasks</p>
      </div>
      
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Schedule</th>
              <th>Status</th>
              <th>Last Run</th>
              <th>Next Run</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    content.innerHTML = `<div class="loading">Error loading cron jobs: ${err.message}</div>`;
  }
}

let logInterval = null;

async function renderLogs() {
  const content = document.getElementById('page-content');
  
  content.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Logs</h1>
      <p class="page-subtitle">Real-time system logs (polling every 2s)</p>
    </div>
    
    <div class="log-viewer" id="log-container">
      <div class="loading">Loading...</div>
    </div>
  `;

  async function fetchLogs() {
    try {
      const logs = await api('/logs?lines=200');
      const container = document.getElementById('log-container');
      if (container) {
        if (Array.isArray(logs) && logs.length > 0) {
          container.innerHTML = logs.map(line => 
            `<div class="log-line">${escapeHtml(line)}</div>`
          ).join('');
          container.scrollTop = container.scrollHeight;
        } else {
          container.innerHTML = '<div class="log-line" style="color: var(--text-secondary);">No logs available</div>';
        }
      }
    } catch (err) {
      const container = document.getElementById('log-container');
      if (container) {
        container.innerHTML = `<div class="log-line" style="color: var(--error);">Error: ${err.message}</div>`;
      }
    }
  }

  // Clear any existing interval
  if (logInterval) clearInterval(logInterval);
  
  // Initial fetch
  await fetchLogs();
  
  // Poll every 2 seconds
  logInterval = setInterval(fetchLogs, 2000);
}

// Stop log polling when navigating away
window.addEventListener('hashchange', () => {
  if (logInterval && !window.location.hash.includes('/logs')) {
    clearInterval(logInterval);
    logInterval = null;
  }
});

// Initialize router
const router = new Router({
  '/': renderHome,
  '/sessions': renderSessions,
  '/sessions/:id': renderSessionDetail,
  '/cron': renderCron,
  '/logs': renderLogs,
});
