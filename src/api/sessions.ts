// src/api/sessions.ts — Unified session endpoints (read, create, stream, abort, delete)
//
// Sessions are scoped under agents: /api/agents/:agentId/sessions/:id
// A global list endpoint at /api/sessions lists sessions across all agents.

import { addRoute } from "./routes.js";
import { sendJson, sendError } from "./middleware.js";
import { createLogger } from "../core/logger.js";
import { randomUUID } from "node:crypto";
import { runAgentLoop } from "../core/agent-runner.js";
import { agentEventBus } from "../core/agent-event-bus.js";

const log = createLogger("api:sessions");

// ---------------------------------------------------------------------------
// In-memory active session tracking (TTL + abort support for SSE clients)
// ---------------------------------------------------------------------------

interface ActiveSession {
  id: string;
  agentId: string;
  lastActivity: number;
  abortController?: AbortController;
}

const activeSessions = new Map<string, ActiveSession>();
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 100;

function evictStaleSessions() {
  const now = Date.now();
  for (const [id, session] of activeSessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      session.abortController?.abort();
      activeSessions.delete(id);
      log.debug(`Evicted stale session: ${id}`);
    }
  }
  if (activeSessions.size > MAX_SESSIONS) {
    const sorted = [...activeSessions.entries()].sort((a, b) => a[1].lastActivity - b[1].lastActivity);
    const toRemove = sorted.slice(0, activeSessions.size - MAX_SESSIONS);
    for (const [id, session] of toRemove) {
      session.abortController?.abort();
      activeSessions.delete(id);
      log.debug(`Evicted session (capacity): ${id}`);
    }
  }
}

// ---------------------------------------------------------------------------
// GET /api/sessions — list all sessions across all agents
// ---------------------------------------------------------------------------

addRoute("GET", "/api/sessions", async (_req, res, deps) => {
  if (!deps.sessionStoreManager) {
    sendJson(res, 200, { items: [] });
    return;
  }

  const items: Array<{
    id: string;
    key?: string;
    agentId: string;
    status: string;
    createdAt: string;
    lastActivityAt: string;
  }> = [];

  for (const [agentId, store] of deps.sessionStoreManager.all()) {
    const sessions = await store.list();
    for (const s of sessions) {
      items.push({
        id: s.id,
        key: s.metadata?.key,
        agentId: s.agentId || agentId,
        status: "active",
        createdAt: s.lastActiveAt.toISOString(),
        lastActivityAt: s.lastActiveAt.toISOString(),
      });
    }
  }

  sendJson(res, 200, { items });
});

// ---------------------------------------------------------------------------
// GET /api/agents/:agentId/sessions — list sessions for a specific agent
// ---------------------------------------------------------------------------

addRoute("GET", "/api/agents/:agentId/sessions", async (req, res, deps) => {
  if (!deps.sessionStoreManager) {
    sendJson(res, 200, { items: [] });
    return;
  }

  const store = deps.sessionStoreManager.peek(req.params.agentId);
  if (!store) {
    sendJson(res, 200, { items: [] });
    return;
  }

  const sessions = await store.list();
  const items = sessions.map((s) => ({
    id: s.id,
    key: s.metadata?.key,
    agentId: s.agentId || req.params.agentId,
    status: "active",
    createdAt: s.lastActiveAt.toISOString(),
    lastActivityAt: s.lastActiveAt.toISOString(),
  }));

  sendJson(res, 200, { items });
});

// ---------------------------------------------------------------------------
// GET /api/agents/:agentId/sessions/:id — get session details
// ---------------------------------------------------------------------------

addRoute("GET", "/api/agents/:agentId/sessions/:id", async (req, res, deps) => {
  if (!deps.sessionStoreManager) {
    sendError(res, 503, "Session store not available");
    return;
  }

  const store = deps.sessionStoreManager.peek(req.params.agentId);
  if (!store) {
    sendError(res, 404, `Session "${req.params.id}" not found`);
    return;
  }

  const session = await store.get(req.params.id);
  if (!session) {
    sendError(res, 404, `Session "${req.params.id}" not found`);
    return;
  }

  const messages = await store.getMessages(req.params.id);
  sendJson(res, 200, {
    id: session.id,
    agentId: session.agentId,
    status: "active",
    createdAt: session.lastActiveAt.toISOString(),
    lastActivityAt: session.lastActiveAt.toISOString(),
    metadata: session.metadata,
    history: messages,
  });
});

// ---------------------------------------------------------------------------
// GET /api/agents/:agentId/sessions/:id/messages — get session messages
// ---------------------------------------------------------------------------

addRoute("GET", "/api/agents/:agentId/sessions/:id/messages", async (req, res, deps) => {
  if (!deps.sessionStoreManager) {
    sendError(res, 503, "Session store not available");
    return;
  }

  const store = deps.sessionStoreManager.peek(req.params.agentId);
  if (!store) {
    sendError(res, 404, `Session "${req.params.id}" not found`);
    return;
  }

  const session = await store.get(req.params.id);
  if (!session) {
    sendError(res, 404, `Session "${req.params.id}" not found`);
    return;
  }

  const messages = await store.getMessages(req.params.id);
  sendJson(res, 200, { items: messages });
});

// ---------------------------------------------------------------------------
// GET /api/agents/:agentId/sessions/:id/usage — per-session usage stats
// ---------------------------------------------------------------------------

addRoute("GET", "/api/agents/:agentId/sessions/:id/usage", (req, res, deps) => {
  sendJson(res, 200, deps.usageTracker?.getSession(req.params.id) ?? { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
});

// ---------------------------------------------------------------------------
// POST /api/agents/:agentId/sessions — create or resume a session
// ---------------------------------------------------------------------------

addRoute("POST", "/api/agents/:agentId/sessions", async (req, res, deps) => {
  const body = req.body as { sessionKey?: string } | undefined;
  const agentId = req.params.agentId;

  if (!deps.agentManager) {
    sendError(res, 503, "Agent manager not available");
    return;
  }

  const agent = deps.agentManager.get(agentId);
  if (!agent) {
    sendError(res, 404, `Agent "${agentId}" not found`);
    return;
  }

  const SESSION_KEY_RE = /^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/;
  const SESSION_KEY_MAX_LEN = 128;

  let sessionKey: string;
  if (body?.sessionKey) {
    if (body.sessionKey.length > SESSION_KEY_MAX_LEN) {
      sendError(res, 400, `sessionKey exceeds max length of ${SESSION_KEY_MAX_LEN}`);
      return;
    }
    if (!SESSION_KEY_RE.test(body.sessionKey)) {
      sendError(res, 400, "Invalid sessionKey format — expected 'namespace:identifier'");
      return;
    }
    sessionKey = `${agentId}:${body.sessionKey}`;
  } else {
    sessionKey = `chat:${agentId}:${randomUUID()}`;
  }

  let sessionId: string;
  let resumed = false;
  if (deps.sessionStoreManager) {
    const store = await deps.sessionStoreManager.getOrCreate(agentId);
    const existing = await store.findByKey(sessionKey);
    if (existing) {
      sessionId = existing.id;
      resumed = true;
    } else {
      const session = await store.create(agentId, { key: sessionKey });
      sessionId = session.id;
    }
  } else {
    sessionId = randomUUID();
  }

  evictStaleSessions();
  activeSessions.set(sessionId, { id: sessionId, agentId, lastActivity: Date.now() });

  log.info(`Session ${resumed ? "resumed" : "created"}: ${sessionId} (agent: ${agentId}, key: ${sessionKey})`);
  sendJson(res, resumed ? 200 : 201, { sessionId, agentId, resumed });
});

// ---------------------------------------------------------------------------
// POST /api/agents/:agentId/sessions/:id/message — send message, stream via SSE
// ---------------------------------------------------------------------------

addRoute("POST", "/api/agents/:agentId/sessions/:id/message", async (req, res, deps) => {
  const { agentId, id: sessionId } = req.params;
  const session = activeSessions.get(sessionId);
  if (!session) {
    sendError(res, 404, `Active session "${sessionId}" not found — create or resume it first`);
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

  const cache = deps.agentManager.get(agentId);
  if (!cache) {
    sendError(res, 404, `Agent "${agentId}" not found`);
    return;
  }

  if (!deps.sessionStoreManager) {
    sendError(res, 503, "Session store not available");
    return;
  }

  const store = await deps.sessionStoreManager.getOrCreate(agentId);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  const writeEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const sessionEmitter = agentEventBus.session(sessionId);
  const unsub = sessionEmitter.on((e) => {
    if (e.type === "message_update") {
      const ame = e.assistantMessageEvent;
      if (ame.type === "text_delta") {
        writeEvent("text_delta", { text: ame.delta });
      }
    } else if (e.type === "tool_execution_start") {
      writeEvent("tool_call", { toolCallId: e.toolCallId, toolName: e.toolName, args: e.args });
    } else if (e.type === "tool_execution_end") {
      writeEvent("tool_result", { toolCallId: e.toolCallId, toolName: e.toolName, result: e.result, isError: e.isError });
    }
  });

  try {
    const systemPrompt = deps.agentManager.getSystemPrompt?.(agentId) ?? "";
    const cwd = deps.agentManager.getWorkspacePath?.(agentId);

    const result = await runAgentLoop({
      cache,
      sessionStore: store,
      sessionId,
      systemPrompt,
      cwd,
      textInput: body.message,
      log,
      hooks: deps.hooks,
      agentId,
    });

    if (result.errorMessage) {
      writeEvent("error", { message: result.errorMessage });
    }
    writeEvent("agent_end", { stopReason: result.errorMessage ? "error" : "end" });
  } catch (err) {
    writeEvent("error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    unsub();
    agentEventBus.removeSession(sessionId);
    res.end();
  }
});

// ---------------------------------------------------------------------------
// POST /api/agents/:agentId/sessions/:id/abort — abort current response
// ---------------------------------------------------------------------------

addRoute("POST", "/api/agents/:agentId/sessions/:id/abort", (req, res) => {
  const session = activeSessions.get(req.params.id);
  if (!session) {
    sendError(res, 404, `Active session "${req.params.id}" not found`);
    return;
  }

  session.abortController?.abort();
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------------------
// DELETE /api/agents/:agentId/sessions/:id — delete session
// ---------------------------------------------------------------------------

addRoute("DELETE", "/api/agents/:agentId/sessions/:id", async (req, res, deps) => {
  const { agentId, id: sessionId } = req.params;

  const active = activeSessions.get(sessionId);
  if (active) {
    active.abortController?.abort();
    activeSessions.delete(sessionId);
  }

  if (deps.sessionStoreManager) {
    const store = deps.sessionStoreManager.peek(agentId);
    if (store) {
      const session = await store.get(sessionId);
      if (session) {
        await store.delete(sessionId);
        sendJson(res, 200, { ok: true });
        return;
      }
    }
  }

  if (active) {
    sendJson(res, 200, { ok: true });
    return;
  }

  sendError(res, 404, `Session "${sessionId}" not found`);
});
