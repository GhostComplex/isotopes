// src/api/chat.ts — Chat API routes (SSE streaming + REST actions)
// Provides interactive chat capability over HTTP for WebUI plugins.

import { addRoute } from "./routes.js";
import { sendJson, sendError } from "./middleware.js";
import { messageText } from "../core/messages.js";
import { createLogger } from "../core/logger.js";
import { randomUUID } from "node:crypto";
import { runAgentLoop } from "../core/agent-runner.js";

const log = createLogger("api:chat");

interface ChatSession {
  id: string;
  agentId: string;
  createdAt: Date;
  lastActivity: number;
  abortController?: AbortController;
}

const chatSessions = new Map<string, ChatSession>();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SESSIONS = 100;

function evictStaleSessions() {
  const now = Date.now();
  for (const [id, session] of chatSessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      session.abortController?.abort();
      chatSessions.delete(id);
      log.debug(`Evicted stale chat session: ${id}`);
    }
  }
  if (chatSessions.size > MAX_SESSIONS) {
    const sorted = [...chatSessions.entries()].sort((a, b) => a[1].lastActivity - b[1].lastActivity);
    const toRemove = sorted.slice(0, chatSessions.size - MAX_SESSIONS);
    for (const [id, session] of toRemove) {
      session.abortController?.abort();
      chatSessions.delete(id);
      log.debug(`Evicted chat session (capacity): ${id}`);
    }
  }
}

// ---------------------------------------------------------------------------
// POST /api/chat/sessions — create a chat session
// ---------------------------------------------------------------------------

addRoute("POST", "/api/chat/sessions", async (req, res, deps) => {
  const body = req.body as { agentId?: string } | undefined;
  if (!deps.agentManager) {
    sendError(res, 503, "Agent manager not available");
    return;
  }

  const agents = deps.agentManager.list();
  const agentId = body?.agentId ?? agents[0]?.id;
  if (!agentId) {
    sendError(res, 400, "No agent available");
    return;
  }

  const agent = deps.agentManager.get(agentId);
  if (!agent) {
    sendError(res, 404, `Agent "${agentId}" not found`);
    return;
  }

  let sessionId: string;
  if (deps.sessionStoreManager) {
    const store = await deps.sessionStoreManager.getOrCreate(agentId);
    const session = await store.create(agentId, { key: `chat:${agentId}:${randomUUID()}` });
    sessionId = session.id;
  } else {
    sessionId = randomUUID();
  }

  evictStaleSessions();
  chatSessions.set(sessionId, { id: sessionId, agentId, createdAt: new Date(), lastActivity: Date.now() });

  log.info(`Chat session created: ${sessionId} (agent: ${agentId})`);
  sendJson(res, 201, { sessionId, agentId });
});

// ---------------------------------------------------------------------------
// POST /api/chat/sessions/:id/message — send message, stream response via SSE
// ---------------------------------------------------------------------------

addRoute("POST", "/api/chat/sessions/:id/message", async (req, res, deps) => {
  const sessionId = req.params.id;
  const session = chatSessions.get(sessionId);
  if (!session) {
    sendError(res, 404, `Chat session "${sessionId}" not found`);
    return;
  }
  session.lastActivity = Date.now();

  const body = req.body as { message?: string } | undefined;
  if (!body?.message) {
    sendError(res, 400, "Request body must include 'message'");
    return;
  }

  if (!deps.agentManager) {
    sendError(res, 503, "Agent manager not available");
    return;
  }

  const cache = deps.agentManager.get(session.agentId);
  if (!cache) {
    sendError(res, 404, `Agent "${session.agentId}" not found`);
    return;
  }

  if (!deps.sessionStoreManager) {
    sendError(res, 503, "Session store not available");
    return;
  }

  const store = await deps.sessionStoreManager.getOrCreate(session.agentId);

  // Set up SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  const writeEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const agentConfig = deps.agentManager.getConfig?.(session.agentId);
    let lastTextLen = 0;
    const result = await runAgentLoop({
      cache,
      sessionStore: store,
      sessionId,
      systemPrompt: agentConfig?.systemPrompt ?? "",
      textInput: body.message,
      log,
      onTextDelta: (currentText) => {
        const delta = currentText.slice(lastTextLen);
        lastTextLen = currentText.length;
        if (delta) writeEvent("text_delta", { text: delta });
      },
      onToolEvent: (event) => {
        if (event.type === "start") {
          writeEvent("tool_call", { toolName: event.toolName, args: event.args });
        } else {
          writeEvent("tool_result", { toolName: event.toolName, result: event.result, isError: event.isError });
        }
      },
      hooks: deps.hooks,
      agentId: session.agentId,
    });

    if (result.errorMessage) {
      writeEvent("error", { message: result.errorMessage });
    }
    writeEvent("agent_end", { stopReason: result.errorMessage ? "error" : "end" });
  } catch (err) {
    writeEvent("error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
  }
});

// ---------------------------------------------------------------------------
// POST /api/chat/sessions/:id/abort — abort current response
// ---------------------------------------------------------------------------

addRoute("POST", "/api/chat/sessions/:id/abort", (req, res) => {
  const session = chatSessions.get(req.params.id);
  if (!session) {
    sendError(res, 404, `Chat session "${req.params.id}" not found`);
    return;
  }

  session.abortController?.abort();
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/chat/sessions/:id/messages — get message history
// ---------------------------------------------------------------------------

addRoute("GET", "/api/chat/sessions/:id/messages", async (req, res, deps) => {
  const session = chatSessions.get(req.params.id);
  if (!session) {
    sendError(res, 404, `Chat session "${req.params.id}" not found`);
    return;
  }

  if (!deps.sessionStoreManager) {
    sendJson(res, 200, { messages: [] });
    return;
  }

  const store = await deps.sessionStoreManager.getOrCreate(session.agentId);
  const messages = await store.getMessages(req.params.id);
  sendJson(res, 200, {
    messages: messages.map((m) => ({
      role: m.role,
      content: messageText(m),
      timestamp: "timestamp" in m && typeof m.timestamp === "number"
        ? new Date(m.timestamp).toISOString() : undefined,
    })),
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/chat/sessions/:id — delete chat session
// ---------------------------------------------------------------------------

addRoute("DELETE", "/api/chat/sessions/:id", async (req, res, deps) => {
  const sessionId = req.params.id;
  const session = chatSessions.get(sessionId);
  if (!session) {
    sendError(res, 404, `Chat session "${sessionId}" not found`);
    return;
  }

  session.abortController?.abort();
  chatSessions.delete(sessionId);

  if (deps.sessionStoreManager) {
    const store = await deps.sessionStoreManager.getOrCreate(session.agentId);
    await store.delete(sessionId);
  }

  sendJson(res, 200, { ok: true });
});
