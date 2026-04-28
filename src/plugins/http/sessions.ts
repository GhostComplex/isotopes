// src/plugins/http/sessions.ts — Unified session endpoints (read, create, stream, abort, delete)
//
// /api/sessions                        — list all sessions
// /api/sessions/:agentId               — list sessions for one agent
// /api/sessions/:agentId/:key          — single session (detail, messages, usage, etc.)
//
// All endpoints use sessionKey as the external identifier. sessionId (UUID) is
// an internal implementation detail of the session store.

import { addRoute } from "./routes.js";
import { sendJson, sendError } from "./middleware.js";
import { createLogger } from "../../core/logger.js";
import { randomUUID } from "node:crypto";
import { runAgentLoop, abortAgentSession } from "../../core/agent-runner.js";
import { userMessage } from "../../core/messages.js";
import { agentEventBus } from "../../core/agent-event-bus.js";
import type { DefaultSessionStore } from "../../core/session-store.js";
import type { Session } from "../../core/types.js";

const log = createLogger("api:sessions");

// ---------------------------------------------------------------------------
// In-memory active session tracking (TTL + abort support for SSE clients)
// ---------------------------------------------------------------------------

interface ActiveSession {
  sessionKey: string;
  sessionId: string;
  agentId: string;
  lastActivity: number;
  abortController?: AbortController;
  pendingMessages: Array<{ content: string; timestamp: number }>;
}

const activeSessions = new Map<string, ActiveSession>();
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 100;
const MAX_PENDING_MESSAGES = 50;
const MAX_STEER_MESSAGE_LEN = 10_000;

function evictStaleSessions() {
  const now = Date.now();
  for (const [key, session] of activeSessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      session.abortController?.abort();
      activeSessions.delete(key);
      log.debug(`Evicted stale session: ${key}`);
    }
  }
  if (activeSessions.size > MAX_SESSIONS) {
    const sorted = [...activeSessions.entries()].sort((a, b) => a[1].lastActivity - b[1].lastActivity);
    const toRemove = sorted.slice(0, activeSessions.size - MAX_SESSIONS);
    for (const [key, session] of toRemove) {
      session.abortController?.abort();
      activeSessions.delete(key);
      log.debug(`Evicted session (capacity): ${key}`);
    }
  }
}

async function resolveSessionKey(
  store: DefaultSessionStore,
  agentId: string,
  urlKey: string,
): Promise<{ sessionKey: string; sessionId: string; session: Session } | undefined> {
  const sessionKey = `${agentId}:${urlKey}`;
  const session = await store.findByKey(sessionKey);
  if (!session) return undefined;
  return { sessionKey, sessionId: session.id, session };
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
    key: string;
    agentId: string;
    status: string;
    createdAt: string;
    lastActivityAt: string;
  }> = [];

  for (const [agentId, store] of deps.sessionStoreManager.all()) {
    const sessions = await store.list();
    for (const s of sessions) {
      if (!s.metadata?.key) continue;
      items.push({
        key: s.metadata.key,
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
// GET /api/sessions/:agentId — list sessions for a specific agent
// ---------------------------------------------------------------------------

addRoute("GET", "/api/sessions/:agentId", async (req, res, deps) => {
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
  const items = sessions
    .filter((s) => s.metadata?.key)
    .map((s) => ({
      key: s.metadata!.key!,
      agentId: s.agentId || req.params.agentId,
      status: "active",
      createdAt: s.lastActiveAt.toISOString(),
      lastActivityAt: s.lastActiveAt.toISOString(),
    }));

  sendJson(res, 200, { items });
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:agentId/:key — get session details
// ---------------------------------------------------------------------------

addRoute("GET", "/api/sessions/:agentId/:key", async (req, res, deps) => {
  if (!deps.sessionStoreManager) {
    sendError(res, 503, "Session store not available");
    return;
  }

  const store = deps.sessionStoreManager.peek(req.params.agentId);
  if (!store) {
    sendError(res, 404, `Session not found`);
    return;
  }

  const resolved = await resolveSessionKey(store, req.params.agentId, req.params.key);
  if (!resolved) {
    sendError(res, 404, `Session not found`);
    return;
  }

  const messages = await store.getMessages(resolved.sessionId);
  sendJson(res, 200, {
    key: resolved.sessionKey,
    agentId: req.params.agentId,
    status: "active",
    metadata: resolved.session.metadata,
    history: messages,
  });
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:agentId/:key/messages — get session messages
// ---------------------------------------------------------------------------

addRoute("GET", "/api/sessions/:agentId/:key/messages", async (req, res, deps) => {
  if (!deps.sessionStoreManager) {
    sendError(res, 503, "Session store not available");
    return;
  }

  const store = deps.sessionStoreManager.peek(req.params.agentId);
  if (!store) {
    sendError(res, 404, `Session not found`);
    return;
  }

  const resolved = await resolveSessionKey(store, req.params.agentId, req.params.key);
  if (!resolved) {
    sendError(res, 404, `Session not found`);
    return;
  }

  const messages = await store.getMessages(resolved.sessionId);
  sendJson(res, 200, { items: messages });
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:agentId/:key/usage — per-session usage stats
// ---------------------------------------------------------------------------

addRoute("GET", "/api/sessions/:agentId/:key/usage", async (req, res, deps) => {
  if (!deps.sessionStoreManager) {
    sendJson(res, 200, { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
    return;
  }

  const store = deps.sessionStoreManager.peek(req.params.agentId);
  if (!store) {
    sendJson(res, 200, { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
    return;
  }

  const resolved = await resolveSessionKey(store, req.params.agentId, req.params.key);
  const sessionId = resolved?.sessionId ?? "";
  sendJson(res, 200, deps.usageTracker?.getSession(sessionId) ?? { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
});

// ---------------------------------------------------------------------------
// POST /api/sessions/:agentId — create or resume a session
// ---------------------------------------------------------------------------

addRoute("POST", "/api/sessions/:agentId", async (req, res, deps) => {
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

  const SESSION_KEY_MAX_LEN = 128;

  let urlKey: string;
  if (body?.sessionKey) {
    if (body.sessionKey.length > SESSION_KEY_MAX_LEN) {
      sendError(res, 400, `sessionKey exceeds max length of ${SESSION_KEY_MAX_LEN}`);
      return;
    }
    urlKey = body.sessionKey;
  } else {
    urlKey = randomUUID();
  }

  const sessionKey = `${agentId}:${urlKey}`;

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
  activeSessions.set(sessionKey, { sessionKey, sessionId, agentId, lastActivity: Date.now(), pendingMessages: [] });

  log.info(`Session ${resumed ? "resumed" : "created"}: ${sessionKey} (agent: ${agentId})`);
  sendJson(res, resumed ? 200 : 201, { key: urlKey, agentId, resumed });
});

// ---------------------------------------------------------------------------
// POST /api/sessions/:agentId/:key/message — send message, stream via SSE
// ---------------------------------------------------------------------------

addRoute("POST", "/api/sessions/:agentId/:key/message", async (req, res, deps) => {
  const { agentId, key: urlKey } = req.params;
  const sessionKey = `${agentId}:${urlKey}`;

  const active = activeSessions.get(sessionKey);
  if (!active) {
    sendError(res, 404, `Active session not found — create or resume it first`);
    return;
  }
  active.lastActivity = Date.now();

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
  const sessionId = active.sessionId;

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
    } else if (e.type === "turn_end") {
      writeEvent("turn_end", {});
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
      onToolComplete: async () => {
        const pending = active.pendingMessages;
        if (pending.length === 0) return null;
        const drained = pending.splice(0);
        for (const m of drained) {
          await store.addMessage(sessionId, userMessage(m.content, m.timestamp));
        }
        const formatted = drained.map((m) => m.content).join("\n");
        return `[Messages arrived while you were working]\n${formatted}`;
      },
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
// POST /api/sessions/:agentId/:key/steer — inject a message mid-run
// ---------------------------------------------------------------------------

addRoute("POST", "/api/sessions/:agentId/:key/steer", async (req, res, _deps) => {
  const sessionKey = `${req.params.agentId}:${req.params.key}`;
  const active = activeSessions.get(sessionKey);
  if (!active) {
    sendError(res, 404, `Active session not found`);
    return;
  }

  const body = req.body as { message?: string } | undefined;
  if (!body?.message) {
    sendError(res, 400, "Request body must include 'message'");
    return;
  }
  if (body.message.length > MAX_STEER_MESSAGE_LEN) {
    sendError(res, 400, `Message exceeds max length of ${MAX_STEER_MESSAGE_LEN}`);
    return;
  }
  if (active.pendingMessages.length >= MAX_PENDING_MESSAGES) {
    sendError(res, 429, `Steer queue full (max ${MAX_PENDING_MESSAGES})`);
    return;
  }

  active.pendingMessages.push({ content: body.message, timestamp: Date.now() });
  active.lastActivity = Date.now();
  log.debug(`Steer message queued for session ${sessionKey}`);
  sendJson(res, 200, { ok: true, queued: active.pendingMessages.length });
});

// ---------------------------------------------------------------------------
// POST /api/sessions/:agentId/:key/abort — abort current response
// ---------------------------------------------------------------------------

addRoute("POST", "/api/sessions/:agentId/:key/abort", (req, res) => {
  const sessionKey = `${req.params.agentId}:${req.params.key}`;
  const session = activeSessions.get(sessionKey);
  if (!session) {
    sendError(res, 404, `Active session not found`);
    return;
  }

  abortAgentSession(session.sessionId);
  session.pendingMessages.length = 0;
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------------------
// DELETE /api/sessions/:agentId/:key — delete session
// ---------------------------------------------------------------------------

addRoute("DELETE", "/api/sessions/:agentId/:key", async (req, res, deps) => {
  const { agentId, key: urlKey } = req.params;
  const sessionKey = `${agentId}:${urlKey}`;

  const active = activeSessions.get(sessionKey);
  if (active) {
    active.abortController?.abort();
    activeSessions.delete(sessionKey);
  }

  if (deps.sessionStoreManager) {
    const store = deps.sessionStoreManager.peek(agentId);
    if (store) {
      const resolved = await resolveSessionKey(store, agentId, urlKey);
      if (resolved) {
        await store.delete(resolved.sessionId);
        sendJson(res, 200, { ok: true });
        return;
      }
    }
  }

  if (active) {
    sendJson(res, 200, { ok: true });
    return;
  }

  sendError(res, 404, `Session not found`);
});
