// src/http/sessions.ts — sessionKey is the external id; sessionId (UUID) is internal to the store.

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createLogger } from "../logging/logger.js";
import type { ApiDeps } from "./server.js";

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

export function registerSessionRoutes(app: Hono, deps: ApiDeps): void {
  app.get("/api/sessions", async (c) => {
    const sessions = await deps.gateway.listSessions();
    return c.json({
      items: sessions.map((s) => ({
        key: s.metadata!.key!,
        agentId: s.agentId,
        status: "active",
        createdAt: s.lastActiveAt.toISOString(),
        lastActivityAt: s.lastActiveAt.toISOString(),
      })),
    });
  });

  app.get("/api/sessions/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    const sessions = await deps.gateway.listSessionsForAgent(agentId);
    return c.json({
      items: sessions.map((s) => ({
        key: s.metadata!.key!,
        agentId: s.agentId || agentId,
        status: "active",
        createdAt: s.lastActiveAt.toISOString(),
        lastActivityAt: s.lastActiveAt.toISOString(),
      })),
    });
  });

  app.get("/api/sessions/:agentId/:key", async (c) => {
    const agentId = c.req.param("agentId");
    const key = c.req.param("key");
    const session = await deps.gateway.getSession(agentId, key);
    if (!session) return c.json({ error: "Session not found", status: 404 }, 404);
    const messages = (await deps.gateway.getMessages(agentId, key)) ?? [];
    return c.json({
      key,
      agentId,
      status: "active",
      metadata: session.metadata,
      history: messages,
    });
  });

  app.get("/api/sessions/:agentId/:key/messages", async (c) => {
    const messages = await deps.gateway.getMessages(c.req.param("agentId"), c.req.param("key"));
    if (messages === undefined) return c.json({ error: "Session not found", status: 404 }, 404);
    return c.json({ items: messages });
  });

  app.get("/api/sessions/:agentId/:key/stream", async (c) => {
    const agentId = c.req.param("agentId");
    const key = c.req.param("key");

    return streamSSE(c, async (stream) => {
      // Initial flush so buffering proxies don't hold the response.
      await stream.writeSSE({ data: "", event: "connected" });

      let closed = false;
      const unsubscribe = await deps.gateway.subscribeMessages(agentId, key, (update) => {
        if (closed) return;
        void stream.writeSSE({
          event: "message",
          data: JSON.stringify({ message: update.message, messageId: update.messageId }),
        });
      });
      if (!unsubscribe) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: "Session not found" }) });
        return;
      }

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
    if (!deps.gateway.agentExists(agentId)) {
      return c.json({ error: `Agent "${agentId}" not found`, status: 404 }, 404);
    }
    const body = (await c.req.json().catch(() => undefined)) as { sessionKey?: string } | undefined;

    const SESSION_KEY_MAX_LEN = 128;
    if (body?.sessionKey && body.sessionKey.length > SESSION_KEY_MAX_LEN) {
      return c.json({ error: `sessionKey exceeds max length of ${SESSION_KEY_MAX_LEN}`, status: 400 }, 400);
    }

    const result = await deps.gateway.createOrResumeSession(agentId, body?.sessionKey);

    evictStaleSessions();
    activeSessions.set(activeKey(agentId, result.sessionKey), {
      sessionKey: result.sessionKey,
      sessionId: result.sessionId,
      agentId,
      lastActivity: Date.now(),
    });
    log.info(`Session ${result.resumed ? "resumed" : "created"}: ${result.sessionKey} (agent: ${agentId})`);
    return c.json({ key: result.sessionKey, agentId, resumed: result.resumed }, result.resumed ? 200 : 201);
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
      const session = await deps.gateway.getSession(agentId, sessionKey);
      if (session) {
        active = { sessionKey, sessionId: session.id, agentId, lastActivity: Date.now() };
        activeSessions.set(activeKey(agentId, sessionKey), active);
      }
    }
    if (!active) return c.json({ error: "Session not found", status: 404 }, 404);
    active.lastActivity = Date.now();

    const body = (await c.req.json().catch(() => undefined)) as { message?: string } | undefined;
    if (!body?.message) {
      return c.json({ error: "Request body must include 'message'", status: 400 }, 400);
    }
    if (!deps.gateway.agentExists(agentId)) {
      return c.json({ error: `Agent "${agentId}" not found`, status: 404 }, 404);
    }

    return streamSSE(c, async (stream) => {
      const writeEvent = (event: string, data: unknown) =>
        void stream.writeSSE({ event, data: JSON.stringify(data) });

      try {
        const result = await deps.gateway.dispatch(
          { agentId, sessionKey: active!.sessionKey, content: body.message!, source: "tui" },
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
    await deps.gateway.abort(session.sessionId, "user");
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

    const deleted = await deps.gateway.deleteSession(agentId, sessionKey);
    if (deleted || active) return c.json({ ok: true });
    return c.json({ error: "Session not found", status: 404 }, 404);
  });
}
