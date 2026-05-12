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
import { createLogger } from "../../logging/logger.js";
import { randomUUID } from "node:crypto";
import { resolveAgentWorkspacePath } from "../../paths.js";
import type { DefaultSessionStore } from "../../agent/pi/session-store.js";
import type { Session } from "../../sessions/types.js";

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
}

const activeSessions = new Map<string, ActiveSession>();
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 100;

/** sessionKey alone is per-agent unique; two agents can legally hold the same key. */
const activeKey = (agentId: string, sessionKey: string) => `${agentId}\x00${sessionKey}`;

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
  sessionKey: string,
): Promise<{ sessionKey: string; sessionId: string; session: Session } | undefined> {
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

  const resolved = await resolveSessionKey(store, req.params.key);
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

  const resolved = await resolveSessionKey(store, req.params.key);
  if (!resolved) {
    sendError(res, 404, `Session not found`);
    return;
  }

  const messages = await store.getMessages(resolved.sessionId);
  sendJson(res, 200, { items: messages });
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:agentId/:key/stream — observer SSE for transcript appends
// ---------------------------------------------------------------------------

addRoute("GET", "/api/sessions/:agentId/:key/stream", async (req, res, deps) => {
  if (!deps.sessionStoreManager) {
    sendError(res, 503, "Session store not available");
    return;
  }
  const store = deps.sessionStoreManager.peek(req.params.agentId);
  if (!store) {
    sendError(res, 404, "Session not found");
    return;
  }
  const resolved = await resolveSessionKey(store, req.params.key);
  if (!resolved) {
    sendError(res, 404, "Session not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  // Initial flush — without this, buffering proxies (nginx default) hold the
  // response until the first event, which can be 25s on a quiet session.
  res.write(": connected\n\n");

  const unsubscribe = store.subscribe(resolved.sessionId, (update) => {
    res.write(`event: message\ndata: ${JSON.stringify({
      message: update.message,
      messageId: update.messageId,
    })}\n\n`);
  });

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  res.on("close", cleanup);
  req.on("aborted", cleanup);
});

// ---------------------------------------------------------------------------
// POST /api/sessions/:agentId — create or resume a session
// ---------------------------------------------------------------------------

addRoute("POST", "/api/sessions/:agentId", async (req, res, deps) => {
  const body = req.body as { sessionKey?: string } | undefined;
  const agentId = req.params.agentId;

  if (!deps.agentRuntime) {
    sendError(res, 503, "Agent runtime not available");
    return;
  }

  const agent = deps.agentRuntime.getAgent(agentId)?.config;
  if (!agent) {
    sendError(res, 404, `Agent "${agentId}" not found`);
    return;
  }

  const SESSION_KEY_MAX_LEN = 128;

  let sessionKey: string;
  if (body?.sessionKey) {
    if (body.sessionKey.length > SESSION_KEY_MAX_LEN) {
      sendError(res, 400, `sessionKey exceeds max length of ${SESSION_KEY_MAX_LEN}`);
      return;
    }
    sessionKey = body.sessionKey;
  } else {
    sessionKey = randomUUID();
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
  activeSessions.set(activeKey(agentId, sessionKey), { sessionKey, sessionId, agentId, lastActivity: Date.now() });

  log.info(`Session ${resumed ? "resumed" : "created"}: ${sessionKey} (agent: ${agentId})`);
  sendJson(res, resumed ? 200 : 201, { key: sessionKey, agentId, resumed });
});

// ---------------------------------------------------------------------------
// POST /api/sessions/:agentId/:key/dispatch — single entry point
//
// Always opens SSE and calls gateway.dispatch. Two outcomes:
//   - state === "started": this dispatch owns a fresh run; SSE streams its
//     events (text_delta / tool_call / tool_result / turn_end) and closes
//     with agent_end.
//   - state === "queued": there's an active run; gateway steered into it.
//     SSE writes a single "queued" event and closes immediately. The
//     steered output flows through the **original** dispatch's SSE
//     (still open in the client).
// ---------------------------------------------------------------------------

addRoute("POST", "/api/sessions/:agentId/:key/dispatch", async (req, res, deps) => {
  const { agentId, key: sessionKey } = req.params;

  let active = activeSessions.get(activeKey(agentId, sessionKey));
  if (!active) {
    // Session may exist in the store but was never registered via the HTTP
    // create path (e.g. channel-driven sessions like Discord). Look it up
    // and register on demand so HTTP clients can send into it.
    if (deps.sessionStoreManager) {
      const store = deps.sessionStoreManager.peek(agentId);
      if (store) {
        const resolved = await resolveSessionKey(store, sessionKey);
        if (resolved) {
          active = {
            sessionKey: resolved.sessionKey,
            sessionId: resolved.sessionId,
            agentId,
            lastActivity: Date.now(),
          };
          activeSessions.set(activeKey(agentId, resolved.sessionKey), active);
        }
      }
    }
  }
  if (!active) {
    sendError(res, 404, `Session not found`);
    return;
  }
  active.lastActivity = Date.now();

  const body = req.body as { message?: string } | undefined;
  if (!body?.message) {
    sendError(res, 400, "Request body must include 'message'");
    return;
  }

  if (!deps.agentRuntime) {
    sendError(res, 503, "Agent runtime not available");
    return;
  }
  if (!deps.sessionStoreManager) {
    sendError(res, 503, "Session store not available");
    return;
  }
  if (!deps.gateway) {
    sendError(res, 503, "Gateway not available");
    return;
  }
  if (!deps.agentRuntime.getAgent(agentId)?.config) {
    sendError(res, 404, `Agent "${agentId}" not found`);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  const writeEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const cwd = ((c) => c ? resolveAgentWorkspacePath(c) : undefined)(deps.agentRuntime?.getAgent(agentId)?.config);

    const result = await deps.gateway.dispatch(
      {
        agentId,
        sessionKey: active.sessionKey,
        content: body.message,
        source: "tui",
        ...(cwd ? { cwd } : {}),
      },
      {
        onTextDelta: (delta) => writeEvent("text_delta", { text: delta }),
        onToolStart: (call) => writeEvent("tool_call", { toolCallId: call.id, toolName: call.name, args: call.args }),
        onToolEnd: (r) => writeEvent("tool_result", { toolCallId: r.id, toolName: r.name, result: r.result, isError: r.isError }),
        onTurnEnd: () => writeEvent("turn_end", {}),
      },
    );

    if (result.state === "queued") {
      writeEvent("queued", { sessionId: result.sessionId });
    } else {
      if (result.errorMessage) {
        writeEvent("error", { message: result.errorMessage });
      }
      writeEvent("agent_end", { stopReason: result.errorMessage ? "error" : "end" });
    }
  } catch (err) {
    writeEvent("error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
  }
});

// ---------------------------------------------------------------------------
// POST /api/sessions/:agentId/:key/abort — abort current response
// ---------------------------------------------------------------------------

addRoute("POST", "/api/sessions/:agentId/:key/abort", async (req, res, deps) => {
  const { agentId, key: sessionKey } = req.params;
  const session = activeSessions.get(activeKey(agentId, sessionKey));
  if (!session) {
    sendError(res, 404, `Active session not found`);
    return;
  }

  if (deps.gateway) {
    await deps.gateway.abort(session.sessionId, "user");
  }
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------------------
// DELETE /api/sessions/:agentId/:key — delete session
// ---------------------------------------------------------------------------

addRoute("DELETE", "/api/sessions/:agentId/:key", async (req, res, deps) => {
  const { agentId, key: sessionKey } = req.params;

  const active = activeSessions.get(activeKey(agentId, sessionKey));
  if (active) {
    active.abortController?.abort();
    activeSessions.delete(activeKey(agentId, sessionKey));
  }

  if (deps.sessionStoreManager) {
    const store = deps.sessionStoreManager.peek(agentId);
    if (store) {
      const resolved = await resolveSessionKey(store, sessionKey);
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
