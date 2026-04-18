// src/api/chat.test.ts — Unit tests for WebChat API routes

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { ApiServer } from "./server.js";
import { AcpSessionManager } from "../acp/session-manager.js";
import { CronScheduler } from "../automation/cron-job.js";
import {
  createMockAgentInstance,
  createMockAgentManager,
  createMockSessionStore,
} from "../core/test-helpers.js";
import type { AgentManager, SessionStore } from "../core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionManager(): AcpSessionManager {
  return new AcpSessionManager({
    enabled: true,
    defaultAgent: "claude",
    allowedAgents: ["claude", "codex"],
  });
}

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let data: unknown;
          try {
            data = JSON.parse(raw);
          } catch {
            data = raw;
          }
          resolve({ status: res.statusCode ?? 0, data, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Read SSE stream and return raw data lines */
function requestSSE(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; events: string[]; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          const events = raw
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6));
          resolve({ status: res.statusCode ?? 0, events, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Chat API routes", () => {
  let server: ApiServer;
  let agentManager: AgentManager;
  let chatSessionStore: SessionStore;

  beforeEach(async () => {
    const acpSessionManager = makeSessionManager();
    const cronScheduler = new CronScheduler();
    agentManager = createMockAgentManager();
    chatSessionStore = createMockSessionStore();
    server = new ApiServer(
      { port: 0 },
      acpSessionManager,
      cronScheduler,
      undefined,
      agentManager,
      chatSessionStore,
    );
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  function getPort(): number {
    const addr = server.address();
    if (!addr) throw new Error("Server not listening");
    return addr.port;
  }

  // -----------------------------------------------------------------------
  // POST /api/chat/message
  // -----------------------------------------------------------------------

  describe("POST /api/chat/message", () => {
    it("returns a reply with a new sessionId", async () => {
      const { status, data } = await request(getPort(), "POST", "/api/chat/message", {
        agentId: "claude",
        message: "Hello!",
      });

      expect(status).toBe(200);
      const body = data as { sessionId: string; reply: string };
      expect(body.sessionId).toBe("session-123");
      expect(body.reply).toBe("Hello world!");
    });

    it("reuses existing sessionId", async () => {
      // Mock sessionStore.get to return a session
      (chatSessionStore.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "existing-session",
        agentId: "claude",
        lastActiveAt: new Date(),
      });

      const { status, data } = await request(getPort(), "POST", "/api/chat/message", {
        agentId: "claude",
        message: "Follow up",
        sessionId: "existing-session",
      });

      expect(status).toBe(200);
      const body = data as { sessionId: string };
      expect(body.sessionId).toBe("existing-session");
    });

    it("returns 400 when agentId is missing", async () => {
      const { status, data } = await request(getPort(), "POST", "/api/chat/message", {
        message: "Hello!",
      });

      expect(status).toBe(400);
      expect((data as { error: string }).error).toContain("agentId");
    });

    it("returns 400 when message is missing", async () => {
      const { status, data } = await request(getPort(), "POST", "/api/chat/message", {
        agentId: "claude",
      });

      expect(status).toBe(400);
      expect((data as { error: string }).error).toContain("message");
    });

    it("returns 404 for unknown agent", async () => {
      (agentManager.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);

      const { status, data } = await request(getPort(), "POST", "/api/chat/message", {
        agentId: "nonexistent",
        message: "Hello!",
      });

      expect(status).toBe(404);
      expect((data as { error: string }).error).toContain("nonexistent");
    });

    it("handles agent error in agent_end event", async () => {
      const errorAgent = createMockAgentInstance([
        { type: "agent_end", messages: [], stopReason: "error", errorMessage: "Model overloaded" },
      ]);
      (agentManager.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(errorAgent);

      const { status, data } = await request(getPort(), "POST", "/api/chat/message", {
        agentId: "claude",
        message: "Hello!",
      });

      expect(status).toBe(200);
      const body = data as { error: string };
      expect(body.error).toBe("Model overloaded");
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/chat/stream
  // -----------------------------------------------------------------------

  describe("POST /api/chat/stream", () => {
    it("streams SSE events with text deltas", async () => {
      const { status, events, headers } = await requestSSE(
        getPort(),
        "/api/chat/stream",
        { agentId: "claude", message: "Hello!" },
      );

      expect(status).toBe(200);
      expect(headers["content-type"]).toBe("text/event-stream");

      // First event is sessionId
      const firstEvent = JSON.parse(events[0]);
      expect(firstEvent.sessionId).toBe("session-123");

      // Text delta events
      const textEvents = events
        .filter((e) => e !== "[DONE]")
        .map((e) => JSON.parse(e))
        .filter((e) => e.text);
      expect(textEvents).toHaveLength(2);
      expect(textEvents[0].text).toBe("Hello ");
      expect(textEvents[1].text).toBe("world!");

      // Last event is [DONE]
      expect(events[events.length - 1]).toBe("[DONE]");
    });

    it("returns 400 when agentId is missing", async () => {
      const { status, data } = await request(getPort(), "POST", "/api/chat/stream", {
        message: "Hello!",
      });

      expect(status).toBe(400);
      expect((data as { error: string }).error).toContain("agentId");
    });

    it("returns 400 when message is missing", async () => {
      const { status, data } = await request(getPort(), "POST", "/api/chat/stream", {
        agentId: "claude",
      });

      expect(status).toBe(400);
      expect((data as { error: string }).error).toContain("message");
    });

    it("returns 404 for unknown agent", async () => {
      (agentManager.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);

      const { status, data } = await request(getPort(), "POST", "/api/chat/stream", {
        agentId: "nonexistent",
        message: "Hello!",
      });

      expect(status).toBe(404);
      expect((data as { error: string }).error).toContain("nonexistent");
    });

    it("sends error event on agent error", async () => {
      const errorAgent = createMockAgentInstance([
        { type: "text_delta", text: "partial" },
        { type: "agent_end", messages: [], stopReason: "error", errorMessage: "Boom" },
      ]);
      (agentManager.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(errorAgent);

      const { events } = await requestSSE(
        getPort(),
        "/api/chat/stream",
        { agentId: "claude", message: "Hello!" },
      );

      const errorEvents = events
        .filter((e) => e !== "[DONE]")
        .map((e) => JSON.parse(e))
        .filter((e) => e.error);
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error).toBe("Boom");
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/chat/agents
  // -----------------------------------------------------------------------

  describe("GET /api/chat/agents", () => {
    it("returns agent list", async () => {
      (agentManager.list as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: "claude", systemPrompt: "" },
        { id: "codex", systemPrompt: "" },
      ]);

      const { status, data } = await request(getPort(), "GET", "/api/chat/agents");
      expect(status).toBe(200);
      const agents = data as Array<{ id: string }>;
      expect(agents).toHaveLength(2);
      expect(agents[0].id).toBe("claude");
      expect(agents[1].id).toBe("codex");
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/chat/history
  // -----------------------------------------------------------------------

  describe("GET /api/chat/history", () => {
    it("returns 400 without sessionId", async () => {
      const { status, data } = await request(getPort(), "GET", "/api/chat/history");
      expect(status).toBe(400);
      expect((data as { error: string }).error).toContain("sessionId");
    });

    it("returns 404 for unknown session", async () => {
      const { status } = await request(
        getPort(),
        "GET",
        "/api/chat/history?sessionId=nonexistent",
      );
      expect(status).toBe(404);
    });

    it("returns message history", async () => {
      (chatSessionStore.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "sess-1",
        agentId: "claude",
        lastActiveAt: new Date(),
      });
      (chatSessionStore.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          role: "user",
          content: [{ type: "text", text: "Hello!" }],
          timestamp: 1000,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hi there!" }],
          timestamp: 2000,
        },
      ]);

      const { status, data } = await request(
        getPort(),
        "GET",
        "/api/chat/history?sessionId=sess-1",
      );

      expect(status).toBe(200);
      const body = data as {
        sessionId: string;
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.sessionId).toBe("sess-1");
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe("user");
      expect(body.messages[0].content).toBe("Hello!");
      expect(body.messages[1].content).toBe("Hi there!");
    });
  });

  // -----------------------------------------------------------------------
  // Chat not configured
  // -----------------------------------------------------------------------

  describe("when chat is not configured", () => {
    let serverNoDeps: ApiServer;

    beforeEach(async () => {
      serverNoDeps = new ApiServer(
        { port: 0 },
        makeSessionManager(),
        new CronScheduler(),
      );
      await serverNoDeps.start();
    });

    afterEach(async () => {
      await serverNoDeps.stop();
    });

    function getPort2(): number {
      const addr = serverNoDeps.address();
      if (!addr) throw new Error("Server not listening");
      return addr.port;
    }

    it("returns 501 for /api/chat/message", async () => {
      const { status, data } = await request(getPort2(), "POST", "/api/chat/message", {
        agentId: "claude",
        message: "Hello!",
      });
      expect(status).toBe(501);
      expect((data as { error: string }).error).toContain("not configured");
    });

    it("returns 501 for /api/chat/stream", async () => {
      const { status, data } = await request(getPort2(), "POST", "/api/chat/stream", {
        agentId: "claude",
        message: "Hello!",
      });
      expect(status).toBe(501);
      expect((data as { error: string }).error).toContain("not configured");
    });

    it("returns 501 for /api/chat/agents", async () => {
      const { status, data } = await request(getPort2(), "GET", "/api/chat/agents");
      expect(status).toBe(501);
      expect((data as { error: string }).error).toContain("not configured");
    });
  });
});
