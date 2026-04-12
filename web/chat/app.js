// Isotopes Chat — Vanilla JS frontend

const API_BASE = window.location.origin;
const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send-btn");
const agentSelect = document.getElementById("agent-select");
const newChatBtn = document.getElementById("new-chat-btn");
const sessionListEl = document.getElementById("session-list");
const readonlyBanner = document.getElementById("readonly-banner");
const inputArea = document.getElementById("input-area");

let sessionId = localStorage.getItem("isotopes-chat-session");
let sending = false;
let isReadonly = false;
let sessions = [];
let sessionPollTimer = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function appendMessage(role, content) {
  const div = document.createElement("div");
  div.className = `message message-${role}`;
  div.textContent = content;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function showTypingIndicator() {
  const div = document.createElement("div");
  div.className = "typing-indicator";
  div.id = "typing";
  div.innerHTML = 'Thinking<span class="typing-dots"></span>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function removeTypingIndicator() {
  const el = document.getElementById("typing");
  if (el) el.remove();
}

function setInputEnabled(enabled) {
  inputEl.disabled = !enabled;
  sendBtn.disabled = !enabled || !inputEl.value.trim();
  sending = !enabled;
}

function autoResize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + "px";
}

function formatTime(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

function sessionDisplayName(session) {
  // Use channel name if available
  if (session.channelName) {
    return `#${session.channelName}`;
  }
  if (session.key) {
    // Discord keys: "discord:{botId}:channel:{channelId}:{agentId}"
    const discordMatch = session.key.match(/^discord:\d+:channel:(\d+):(.+)$/);
    if (discordMatch) {
      const channelId = discordMatch[1];
      return `#${channelId.slice(-6)} (${discordMatch[2]})`;
    }
    // Truncate long keys
    if (session.key.length > 30) return session.key.slice(0, 27) + "…";
    return session.key;
  }
  if (session.agentId) return session.agentId;
  return session.id.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Session sidebar
// ---------------------------------------------------------------------------

async function loadSessions() {
  try {
    const res = await fetch(`${API_BASE}/api/sessions`);
    if (!res.ok) return;
    sessions = await res.json();
    renderSessionList();
  } catch {
    // ignore
  }
}

function renderSessionList() {
  sessionListEl.innerHTML = "";

  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "session-list-empty";
    empty.textContent = "No sessions yet. Start a new chat!";
    sessionListEl.appendChild(empty);
    return;
  }

  // Sort: most recently active first
  const sorted = [...sessions].sort(
    (a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt)
  );

  for (const session of sorted) {
    const item = document.createElement("div");
    item.className = "session-item";
    if (session.id === sessionId) item.classList.add("active");

    const topRow = document.createElement("div");
    topRow.className = "session-item-row";

    const name = document.createElement("span");
    name.className = "session-name";
    name.textContent = sessionDisplayName(session);
    if (session.key) name.title = session.key;

    const badge = document.createElement("span");
    badge.className = `source-badge source-badge-${session.source}`;
    badge.textContent = session.source;

    topRow.appendChild(name);
    topRow.appendChild(badge);

    const meta = document.createElement("div");
    meta.className = "session-meta";
    const parts = [];
    if (session.messageCount > 0) parts.push(`${session.messageCount} msgs`);
    parts.push(formatTime(session.lastActivityAt));
    meta.textContent = parts.join(" · ");

    item.appendChild(topRow);
    item.appendChild(meta);

    item.addEventListener("click", () => switchSession(session));
    sessionListEl.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Session switching
// ---------------------------------------------------------------------------

async function switchSession(session) {
  sessionId = session.id;
  localStorage.setItem("isotopes-chat-session", sessionId);

  // Update readonly state
  const readonly = session.source === "acp";
  setReadonly(readonly);

  // Update active highlight
  renderSessionList();

  // Load session history
  messagesEl.innerHTML = "";
  try {
    const res = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(session.id)}/messages`);
    if (!res.ok) {
      appendMessage("error", `Failed to load session history (${res.status})`);
      return;
    }
    const data = await res.json();
    for (const msg of data.messages) {
      if (msg.role === "tool_result") continue;
      appendMessage(msg.role, msg.content);
    }
    if (data.messages.length === 0) {
      appendMessage("system", "No messages in this session.");
    }
  } catch (err) {
    appendMessage("error", `Failed to load history: ${err.message}`);
  }
}

function setReadonly(readonly) {
  isReadonly = readonly;
  readonlyBanner.style.display = readonly ? "" : "none";
  if (readonly) {
    inputArea.classList.add("disabled");
    inputEl.disabled = true;
    sendBtn.disabled = true;
  } else {
    inputArea.classList.remove("disabled");
    inputEl.disabled = false;
    sendBtn.disabled = !inputEl.value.trim() || sending;
  }
}

// ---------------------------------------------------------------------------
// Load agents
// ---------------------------------------------------------------------------

async function loadAgents() {
  try {
    const res = await fetch(`${API_BASE}/api/chat/agents`);
    if (!res.ok) throw new Error(`${res.status}`);
    const agents = await res.json();

    agentSelect.innerHTML = "";
    for (const agent of agents) {
      const opt = document.createElement("option");
      opt.value = agent.id;
      opt.textContent = agent.id;
      agentSelect.appendChild(opt);
    }

    // Restore previously selected agent
    const saved = localStorage.getItem("isotopes-chat-agent");
    if (saved && agents.some((a) => a.id === saved)) {
      agentSelect.value = saved;
    }
  } catch (err) {
    agentSelect.innerHTML = '<option value="">No agents available</option>';
  }
}

// ---------------------------------------------------------------------------
// Load history (for current chat session)
// ---------------------------------------------------------------------------

async function loadHistory() {
  if (!sessionId) return;
  try {
    const res = await fetch(`${API_BASE}/api/chat/history?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) {
      if (res.status === 404) {
        // Session expired, start fresh
        sessionId = null;
        localStorage.removeItem("isotopes-chat-session");
        return;
      }
      return;
    }
    const data = await res.json();
    messagesEl.innerHTML = "";
    for (const msg of data.messages) {
      appendMessage(msg.role, msg.content);
    }
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Send message (SSE streaming)
// ---------------------------------------------------------------------------

async function sendMessage() {
  const message = inputEl.value.trim();
  if (!message || sending || isReadonly) return;

  const agentId = agentSelect.value;
  if (!agentId) {
    appendMessage("error", "No agent selected");
    return;
  }

  // Save agent selection
  localStorage.setItem("isotopes-chat-agent", agentId);

  // Show user message
  appendMessage("user", message);
  inputEl.value = "";
  inputEl.style.height = "auto";
  setInputEnabled(false);

  showTypingIndicator();

  try {
    const res = await fetch(`${API_BASE}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, message, sessionId }),
    });

    if (!res.ok) {
      removeTypingIndicator();
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      appendMessage("error", err.error || `Error: ${res.status}`);
      setInputEnabled(true);
      return;
    }

    // Check content type — fall back to sync if not SSE
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      removeTypingIndicator();
      const data = await res.json();
      if (data.sessionId) {
        sessionId = data.sessionId;
        localStorage.setItem("isotopes-chat-session", sessionId);
        loadSessions();
      }
      if (data.reply) {
        appendMessage("assistant", data.reply);
      }
      if (data.error) {
        appendMessage("error", data.error);
      }
      setInputEnabled(true);
      return;
    }

    // Read X-Session-Id header
    const headerSessionId = res.headers.get("X-Session-Id");
    if (headerSessionId) {
      sessionId = headerSessionId;
      localStorage.setItem("isotopes-chat-session", sessionId);
      loadSessions();
    }

    // Process SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let assistantEl = null;
    let fullText = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);

        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);

          // Session ID event
          if (parsed.sessionId && !parsed.text) {
            sessionId = parsed.sessionId;
            localStorage.setItem("isotopes-chat-session", sessionId);
            loadSessions();
            continue;
          }

          // Text delta
          if (parsed.text) {
            if (!assistantEl) {
              removeTypingIndicator();
              assistantEl = appendMessage("assistant", "");
            }
            fullText += parsed.text;
            assistantEl.textContent = fullText;
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }

          // Error
          if (parsed.error) {
            removeTypingIndicator();
            appendMessage("error", parsed.error);
          }
        } catch {
          // skip malformed JSON
        }
      }
    }

    // If we never got any text, remove typing indicator
    if (!assistantEl) {
      removeTypingIndicator();
    }
  } catch (err) {
    removeTypingIndicator();
    appendMessage("error", `Network error: ${err.message}`);
  }

  setInputEnabled(true);
  inputEl.focus();
}

// ---------------------------------------------------------------------------
// New chat
// ---------------------------------------------------------------------------

function newChat() {
  sessionId = null;
  localStorage.removeItem("isotopes-chat-session");
  messagesEl.innerHTML = "";
  setReadonly(false);
  appendMessage("system", "New conversation started.");
  renderSessionList();
}

// ---------------------------------------------------------------------------
// Session polling
// ---------------------------------------------------------------------------

function startSessionPolling() {
  if (sessionPollTimer) clearInterval(sessionPollTimer);
  sessionPollTimer = setInterval(loadSessions, 30000);
}

// Refresh sessions when window regains focus
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadSessions();
});

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

sendBtn.addEventListener("click", sendMessage);

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

inputEl.addEventListener("input", () => {
  sendBtn.disabled = !inputEl.value.trim() || sending || isReadonly;
  autoResize();
});

newChatBtn.addEventListener("click", newChat);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  await loadAgents();
  await loadSessions();
  if (sessionId) {
    // Check if current session exists in loaded sessions
    const current = sessions.find((s) => s.id === sessionId);
    if (current) {
      switchSession(current);
    } else {
      await loadHistory();
    }
  }
  startSessionPolling();
}

init();
