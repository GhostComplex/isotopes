// src/http/sessions.ts — sessionKey is the external id; sessionId (UUID) is internal to the store.

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createLogger } from "../logging/logger.js";
import { randomUUID } from "node:crypto";
import { resolveAgentWorkspacePath } from "../paths.js";
import type { DefaultSessionStore } from "../agent/pi/session-store.js";
import type { Session } from "../sessions/types.js";
import type { RouteDeps } from "./server.js";

const log = createLogger("api:sessions");

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

function evictStaleSessions(): void {
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

export function registerSessionRoutes(app: Hono, deps: RouteDeps): void {
  app.get("/api/sessions", async (c) => {
    if (!deps.sessionStoreManager) return c.json({ items: [] });
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
    return c.json({ items });
  });

  app.get("/api/sessions/:agentId", async (c) => {
    if (!deps.sessionStoreManager) return c.json({ items: [] });
    const store = deps.sessionStoreManager.peek(c.req.param("agentId"));
    if (!store) return c.json({ items: [] });
    const sessions = await store.list();
    const items = sessions
      .filter((s) => s.metadata?.key)
      .map((s) => ({
        key: s.metadata!.key!,
        agentId: s.agentId || c.req.param("agentId"),
        status: "active",
        createdAt: s.lastActiveAt.toISOString(),
        lastActivityAt: s.lastActiveAt.toISOString(),
      }));
    return c.json({ items });
  });

  app.get("/api/sessions/:agentId/:key", async (c) => {
    if (!deps.sessionStoreManager) return c.json({ error: "Session store not available", status: 503 }, 503);
    const store = deps.sessionStoreManager.peek(c.req.param("agentId"));
    if (!store) return c.json({ error: "Session not found", status: 404 }, 404);
    const resolved = await resolveSessionKey(store, c.req.param("key"));
    if (!resolved) return c.json({ error: "Session not found", status: 404 }, 404);
    const messages = await store.getMessages(resolved.sessionId);
    return c.json({
      key: resolved.sessionKey,
      agentId: c.req.param("agentId"),
      status: "active",
      metadata: resolved.session.metadata,
      history: messages,
    });
  });

  app.get("/api/sessions/:agentId/:key/messages", async (c) => {
    if (!deps.sessionStoreManager) return c.json({ error: "Session store not available", status: 503 }, 503);
    const store = deps.sessionStoreManager.peek(c.req.param("agentId"));
    if (!store) return c.json({ error: "Session not found", status: 404 }, 404);
    const resolved = await resolveSessionKey(store, c.req.param("key"));
    if (!resolved) return c.json({ error: "Session not found", status: 404 }, 404);
    const messages = await store.getMessages(resolved.sessionId);
    return c.json({ items: messages });
  });

  app.get("/api/sessions/:agentId/:key/stream", async (c) => {
    if (!deps.sessionStoreManager) return c.json({ error: "Session store not available", status: 503 }, 503);
    const store = deps.sessionStoreManager.peek(c.req.param("agentId"));
    if (!store) return c.json({ error: "Session not found", status: 404 }, 404);
    const resolved = await resolveSessionKey(store, c.req.param("key"));
    if (!resolved) return c.json({ error: "Session not found", status: 404 }, 404);

    return streamSSE(c, async (stream) => {
      // Initial flush so buffering proxies don't hold the response.
      await stream.writeSSE({ data: "", event: "connected" });

      let closed = false;
      const unsubscribe = store.subscribe(resolved.sessionId, (update) => {
        if (closed) return;
        void stream.writeSSE({
          event: "message",
          data: JSON.stringify({ message: update.message, messageId: update.messageId }),
        });
      });

      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });

      // Heartbeat — keep the connection alive through quiet periods.
      while (!closed) {
        await stream.sleep(25_000);
        if (closed) break;
        await stream.writeSSE({ data: "", event: "ping" });
      }
    });
  });

  app.post("/api/sessions/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    if (!deps.agentRuntime) return c.json({ error: "Agent runtime not available", status: 503 }, 503);
    if (!deps.agentRuntime.getAgent(agentId)?.config) {
      return c.json({ error: `Agent "${agentId}" not found`, status: 404 }, 404);
    }
    const body = (await c.req.json().catch(() => undefined)) as { sessionKey?: string } | undefined;

    const SESSION_KEY_MAX_LEN = 128;
    let sessionKey: string;
    if (body?.sessionKey) {
      if (body.sessionKey.length > SESSION_KEY_MAX_LEN) {
        return c.json({ error: `sessionKey exceeds max length of ${SESSION_KEY_MAX_LEN}`, status: 400 }, 400);
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
    return c.json({ key: sessionKey, agentId, resumed }, resumed ? 200 : 201);
  });

  // Single dispatch entrypoint. Gateway returns "started" (this request owns the
  // run; SSE streams its events) or "queued" (steered into an active run; events
  // flow through the original dispatch's still-open SSE).
  app.post("/api/sessions/:agentId/:key/dispatch", async (c) => {
    const agentId = c.req.param("agentId");
    const sessionKey = c.req.param("key");

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
    if (!active) return c.json({ error: "Session not found", status: 404 }, 404);
    active.lastActivity = Date.now();

    const body = (await c.req.json().catch(() => undefined)) as { message?: string } | undefined;
    if (!body?.message) {
      return c.json({ error: "Request body must include 'message'", status: 400 }, 400);
    }
    if (!deps.agentRuntime) return c.json({ error: "Agent runtime not available", status: 503 }, 503);
    if (!deps.gateway) return c.json({ error: "Gateway not available", status: 503 }, 503);
    if (!deps.agentRuntime.getAgent(agentId)?.config) {
      return c.json({ error: `Agent "${agentId}" not found`, status: 404 }, 404);
    }

    const cwd = ((cfg) => cfg ? resolveAgentWorkspacePath(cfg) : undefined)(
      deps.agentRuntime.getAgent(agentId)?.config,
    );

    return streamSSE(c, async (stream) => {
      const writeEvent = (event: string, data: unknown) =>
        void stream.writeSSE({ event, data: JSON.stringify(data) });

      try {
        const result = await deps.gateway!.dispatch(
          {
            agentId,
            sessionKey: active!.sessionKey,
            content: body.message!,
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
          await stream.writeSSE({ event: "queued", data: JSON.stringify({ sessionId: result.sessionId }) });
        } else {
          if (result.errorMessage) {
            await stream.writeSSE({ event: "error", data: JSON.stringify({ message: result.errorMessage }) });
          }
          await stream.writeSSE({ event: "agent_end", data: JSON.stringify({ stopReason: result.errorMessage ? "error" : "end" }) });
        }
      } catch (err) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: err instanceof Error ? err.message : String(err) }),
        });
      }
    });
  });

  app.post("/api/sessions/:agentId/:key/abort", async (c) => {
    const session = activeSessions.get(activeKey(c.req.param("agentId"), c.req.param("key")));
    if (!session) return c.json({ error: "Active session not found", status: 404 }, 404);
    if (deps.gateway) {
      await deps.gateway.abort(session.sessionId, "user");
    }
    return c.json({ ok: true });
  });

  app.delete("/api/sessions/:agentId/:key", async (c) => {
    const agentId = c.req.param("agentId");
    const sessionKey = c.req.param("key");

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
          return c.json({ ok: true });
        }
      }
    }

    if (active) return c.json({ ok: true });
    return c.json({ error: "Session not found", status: 404 }, 404);
  });
}
