// Isotopes Chat — Vanilla JS frontend

const API_BASE = window.location.origin;
const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send-btn");
const agentSelect = document.getElementById("agent-select");
const newChatBtn = document.getElementById("new-chat-btn");

let sessionId = localStorage.getItem("isotopes-chat-session");
let sending = false;

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
// Load history
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
  if (!message || sending) return;

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
  appendMessage("system", "New conversation started.");
}

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
  sendBtn.disabled = !inputEl.value.trim() || sending;
  autoResize();
});

newChatBtn.addEventListener("click", newChat);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

loadAgents().then(() => loadHistory());
