import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ApiDeps } from "./server.js";


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

  app.get("/api/sessions/:agentId/:key/messages", async (c) => {
    const messages = await deps.gateway.getMessages(c.req.param("agentId"), c.req.param("key"));
    if (messages === undefined) return c.json({ error: "Session not found", status: 404 }, 404);
    return c.json({ items: messages });
  });

  app.get("/api/sessions/:agentId/:key/stream", async (c) => {
    const agentId = c.req.param("agentId");
    const key = c.req.param("key");

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: "", event: "connected" });

      let closed = false;
      const unsubscribe = await deps.gateway.subscribe(agentId, key, (event) => {
        if (closed) return;
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      });
      if (!unsubscribe) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: "Session not found" }) });
        return;
      }

      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });

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
    return c.json({ key: result.sessionKey, agentId, resumed: result.resumed }, result.resumed ? 200 : 201);
  });

  app.post("/api/sessions/:agentId/:key/dispatch", async (c) => {
    const agentId = c.req.param("agentId");
    const sessionKey = c.req.param("key");

    if (!deps.gateway.agentExists(agentId)) {
      return c.json({ error: `Agent "${agentId}" not found`, status: 404 }, 404);
    }
    const session = await deps.gateway.getSession(agentId, sessionKey);
    if (!session) return c.json({ error: "Session not found", status: 404 }, 404);

    const body = (await c.req.json().catch(() => undefined)) as { message?: string } | undefined;
    if (!body?.message) {
      return c.json({ error: "Request body must include 'message'", status: 400 }, 400);
    }

    const result = await deps.gateway.dispatch({
      agentId,
      sessionKey,
      content: body.message,
      source: "tui",
    });
    return c.json({ sessionId: result.sessionId, state: result.state });
  });

  app.post("/api/sessions/:agentId/:key/abort", async (c) => {
    const agentId = c.req.param("agentId");
    const sessionKey = c.req.param("key");
    const aborted = await deps.gateway.abortByKey(agentId, sessionKey, "user");
    if (!aborted) return c.json({ error: "No active run for this session", status: 404 }, 404);
    return c.json({ ok: true });
  });

  app.delete("/api/sessions/:agentId/:key", async (c) => {
    const agentId = c.req.param("agentId");
    const sessionKey = c.req.param("key");
    const deleted = await deps.gateway.deleteSession(agentId, sessionKey);
    if (!deleted) return c.json({ error: "Session not found", status: 404 }, 404);
    return c.json({ ok: true });
  });
}
