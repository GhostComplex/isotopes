// src/api/routes.test.ts — Unit tests for REST route handlers

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { ApiServer } from "./server.js";
import { AcpSessionManager } from "../acp/session-manager.js";
import { CronScheduler } from "../automation/cron-job.js";
import {
  createMockAgentManager,
  createMockAgentInstance,
  createMockSessionStore,
} from "../core/test-helpers.js";
import type { AgentManager, SessionStore } from "../core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionManager(): AcpSessionManager {
  return new AcpSessionManager({
    enabled: true,
    backend: "acpx",
    defaultAgent: "claude",
    allowedAgents: ["claude", "codex"],
  });
}

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
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
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("API routes", () => {
  let server: ApiServer;
  let sessionManager: AcpSessionManager;
  let cronScheduler: CronScheduler;

  beforeEach(async () => {
    sessionManager = makeSessionManager();
    cronScheduler = new CronScheduler();
    server = new ApiServer({ port: 0 }, sessionManager, cronScheduler);
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
  // Sessions
  // -----------------------------------------------------------------------

  describe("GET /api/sessions", () => {
    it("returns empty array when no sessions exist", async () => {
      const { status, data } = await request(getPort(), "GET", "/api/sessions");
      expect(status).toBe(200);
      expect(data).toEqual([]);
    });

    it("returns sessions list", async () => {
      sessionManager.createSession("claude", "thread-1");
      sessionManager.createSession("codex");

      const { status, data } = await request(getPort(), "GET", "/api/sessions");
      expect(status).toBe(200);
      const sessions = data as Array<{ id: string; agentId: string }>;
      expect(sessions).toHaveLength(2);
      expect(sessions[0].agentId).toBe("claude");
      expect(sessions[1].agentId).toBe("codex");
    });

    it("includes messageCount in listing", async () => {
      const s = sessionManager.createSession("claude");
      sessionManager.addMessage(s.id, { role: "user", content: "hello" });

      const { data } = await request(getPort(), "GET", "/api/sessions");
      const sessions = data as Array<{ messageCount: number }>;
      expect(sessions[0].messageCount).toBe(1);
    });
  });

  describe("GET /api/sessions/:id", () => {
    it("returns session details with history", async () => {
      const s = sessionManager.createSession("claude", "thread-1");
      sessionManager.addMessage(s.id, { role: "user", content: "Hello" });
      sessionManager.addMessage(s.id, { role: "assistant", content: "Hi!" });

      const { status, data } = await request(getPort(), "GET", `/api/sessions/${s.id}`);
      expect(status).toBe(200);

      const body = data as {
        id: string;
        agentId: string;
        history: Array<{ role: string; content: string }>;
      };
      expect(body.id).toBe(s.id);
      expect(body.agentId).toBe("claude");
      expect(body.history).toHaveLength(2);
      expect(body.history[0].content).toBe("Hello");
      expect(body.history[1].content).toBe("Hi!");
    });

    it("returns 404 for unknown session", async () => {
      const { status, data } = await request(getPort(), "GET", "/api/sessions/nonexistent");
      expect(status).toBe(404);
      expect((data as { error: string }).error).toContain("not found");
    });
  });

  describe("POST /api/sessions/:id/message", () => {
    it("adds a message to a session", async () => {
      const s = sessionManager.createSession("claude");

      const { status, data } = await request(
        getPort(),
        "POST",
        `/api/sessions/${s.id}/message`,
        { role: "user", content: "Hello!" },
      );
      expect(status).toBe(201);
      expect((data as { ok: boolean }).ok).toBe(true);

      // Verify message was added
      const session = sessionManager.getSession(s.id);
      expect(session!.history).toHaveLength(1);
      expect(session!.history[0].content).toBe("Hello!");
      expect(session!.history[0].role).toBe("user");
    });

    it("defaults role to 'user' for invalid roles", async () => {
      const s = sessionManager.createSession("claude");

      await request(getPort(), "POST", `/api/sessions/${s.id}/message`, {
        role: "invalid",
        content: "Test",
      });

      const session = sessionManager.getSession(s.id);
      expect(session!.history[0].role).toBe("user");
    });

    it("accepts 'assistant' and 'system' roles", async () => {
      const s = sessionManager.createSession("claude");

      await request(getPort(), "POST", `/api/sessions/${s.id}/message`, {
        role: "assistant",
        content: "Hi",
      });
      await request(getPort(), "POST", `/api/sessions/${s.id}/message`, {
        role: "system",
        content: "System msg",
      });

      const session = sessionManager.getSession(s.id);
      expect(session!.history[0].role).toBe("assistant");
      expect(session!.history[1].role).toBe("system");
    });

    it("returns 404 for unknown session", async () => {
      const { status } = await request(
        getPort(),
        "POST",
        "/api/sessions/nonexistent/message",
        { content: "Hello" },
      );
      expect(status).toBe(404);
    });

    it("returns 400 when content is missing", async () => {
      const s = sessionManager.createSession("claude");

      const { status, data } = await request(
        getPort(),
        "POST",
        `/api/sessions/${s.id}/message`,
        { role: "user" },
      );
      expect(status).toBe(400);
      expect((data as { error: string }).error).toContain("content");
    });
  });

  describe("DELETE /api/sessions/:id", () => {
    it("terminates a session", async () => {
      const s = sessionManager.createSession("claude");

      const { status, data } = await request(getPort(), "DELETE", `/api/sessions/${s.id}`);
      expect(status).toBe(200);
      expect((data as { ok: boolean }).ok).toBe(true);

      // Verify session is terminated
      expect(sessionManager.getSession(s.id)!.status).toBe("terminated");
    });

    it("returns 404 for unknown session", async () => {
      const { status } = await request(getPort(), "DELETE", "/api/sessions/nonexistent");
      expect(status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // Cron
  // -----------------------------------------------------------------------

  describe("GET /api/cron", () => {
    it("returns empty array when no jobs exist", async () => {
      const { status, data } = await request(getPort(), "GET", "/api/cron");
      expect(status).toBe(200);
      expect(data).toEqual([]);
    });

    it("returns registered cron jobs", async () => {
      cronScheduler.register({
        name: "standup",
        expression: "0 9 * * 1-5",
        agentId: "claude",
        action: { type: "message", content: "Good morning!" },
        enabled: true,
      });

      const { status, data } = await request(getPort(), "GET", "/api/cron");
      expect(status).toBe(200);
      const jobs = data as Array<{ name: string; agentId: string }>;
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe("standup");
      expect(jobs[0].agentId).toBe("claude");
    });
  });

  describe("POST /api/cron", () => {
    it("creates a new cron job", async () => {
      const { status, data } = await request(getPort(), "POST", "/api/cron", {
        name: "daily-report",
        expression: "0 17 * * 1-5",
        agentId: "claude",
        action: { type: "prompt", prompt: "Generate daily report" },
      });

      expect(status).toBe(201);
      const body = data as { id: string; name: string; enabled: boolean };
      expect(body.id).toMatch(/^cron_/);
      expect(body.name).toBe("daily-report");
      expect(body.enabled).toBe(true);

      // Verify job was registered
      expect(cronScheduler.listJobs()).toHaveLength(1);
    });

    it("returns 400 when required fields are missing", async () => {
      const { status } = await request(getPort(), "POST", "/api/cron", {
        name: "incomplete",
      });
      expect(status).toBe(400);
    });

    it("returns 400 when action is missing", async () => {
      const { status } = await request(getPort(), "POST", "/api/cron", {
        name: "no-action",
        expression: "0 9 * * *",
        agentId: "claude",
      });
      expect(status).toBe(400);
    });

    it("returns 500 for invalid cron expression", async () => {
      const { status } = await request(getPort(), "POST", "/api/cron", {
        name: "bad-cron",
        expression: "invalid",
        agentId: "claude",
        action: { type: "message", content: "test" },
      });
      expect(status).toBe(500);
    });
  });

  describe("DELETE /api/cron/:id", () => {
    it("deletes an existing cron job", async () => {
      const job = cronScheduler.register({
        name: "to-delete",
        expression: "0 9 * * *",
        agentId: "claude",
        action: { type: "message", content: "test" },
        enabled: true,
      });

      const { status, data } = await request(getPort(), "DELETE", `/api/cron/${job.id}`);
      expect(status).toBe(200);
      expect((data as { ok: boolean }).ok).toBe(true);

      // Verify job was removed
      expect(cronScheduler.getJob(job.id)).toBeUndefined();
    });

    it("returns 404 for unknown job", async () => {
      const { status } = await request(getPort(), "DELETE", "/api/cron/nonexistent");
      expect(status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // Config
  // -----------------------------------------------------------------------

  describe("GET /api/config", () => {
    it("returns 501 when config reloader is not available", async () => {
      // Server was created without configReloader
      const { status, data } = await request(getPort(), "GET", "/api/config");
      expect(status).toBe(501);
      expect((data as { error: string }).error).toContain("not available");
    });
  });

  describe("PUT /api/config", () => {
    it("returns 501 when config reloader is not available", async () => {
      const { status } = await request(getPort(), "PUT", "/api/config");
      expect(status).toBe(501);
    });
  });

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  describe("GET /api/status", () => {
    it("reflects session and cron counts", async () => {
      sessionManager.createSession("claude");
      sessionManager.createSession("codex");
      cronScheduler.register({
        name: "job1",
        expression: "0 9 * * *",
        agentId: "claude",
        action: { type: "message", content: "test" },
        enabled: true,
      });

      const { status, data } = await request(getPort(), "GET", "/api/status");
      expect(status).toBe(200);
      const body = data as { sessions: number; cronJobs: number };
      expect(body.sessions).toBe(2);
      expect(body.cronJobs).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// WebChat API routes (agents, chat SSE)
// ---------------------------------------------------------------------------

/** Parse SSE stream response into individual events */
function requestSSE(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; events: Array<{ event: string; data: unknown }> }> {
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
          const events: Array<{ event: string; data: unknown }> = [];
          const blocks = raw.split("\n\n").filter(Boolean);
          for (const block of blocks) {
            const lines = block.split("\n");
            let event = "";
            let data = "";
            for (const line of lines) {
              if (line.startsWith("event: ")) event = line.slice(7);
              if (line.startsWith("data: ")) data = line.slice(6);
            }
            if (event && data) {
              try {
                events.push({ event, data: JSON.parse(data) });
              } catch {
                events.push({ event, data });
              }
            }
          }
          resolve({ status: res.statusCode ?? 0, events });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("WebChat API routes", () => {
  let server: ApiServer;
  let sessionManager: AcpSessionManager;
  let cronScheduler: CronScheduler;
  let agentManager: AgentManager;
  let sessionStore: SessionStore;

  beforeEach(async () => {
    sessionManager = makeSessionManager();
    cronScheduler = new CronScheduler();
    agentManager = createMockAgentManager();
    sessionStore = createMockSessionStore();

    // Make list() return a mock agent list
    vi.mocked(agentManager.list).mockReturnValue([
      { id: "major", systemPrompt: "You are Major." },
      { id: "minor", systemPrompt: "You are Minor." },
    ]);

    server = new ApiServer(
      { port: 0 },
      sessionManager,
      cronScheduler,
      undefined,
      {
        agentManager,
        sessionStore,
        sessionStoreForAgent: () => sessionStore,
      },
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
  // GET /api/agents
  // -----------------------------------------------------------------------

  describe("GET /api/agents", () => {
    it("returns list of configured agents", async () => {
      const { status, data } = await request(getPort(), "GET", "/api/agents");
      expect(status).toBe(200);
      const agents = data as Array<{ id: string; name: string }>;
      expect(agents).toHaveLength(2);
      expect(agents[0]).toEqual({ id: "major", name: "major" });
      expect(agents[1]).toEqual({ id: "minor", name: "minor" });
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/chat
  // -----------------------------------------------------------------------

  describe("POST /api/chat", () => {
    it("returns 400 when agentId is missing", async () => {
      const { status, data } = await request(getPort(), "POST", "/api/chat", {
        message: "hello",
      });
      expect(status).toBe(400);
      expect((data as { error: string }).error).toContain("agentId");
    });

    it("returns 400 when message is missing", async () => {
      const { status, data } = await request(getPort(), "POST", "/api/chat", {
        agentId: "major",
      });
      expect(status).toBe(400);
      expect((data as { error: string }).error).toContain("message");
    });

    it("returns 404 for unknown agent", async () => {
      vi.mocked(agentManager.get).mockReturnValue(undefined);

      const { status, data } = await request(getPort(), "POST", "/api/chat", {
        agentId: "nonexistent",
        message: "hello",
      });
      expect(status).toBe(404);
      expect((data as { error: string }).error).toContain("nonexistent");
    });

    it("streams SSE events for a successful chat", async () => {
      const mockAgent = createMockAgentInstance([
        { type: "text_delta", text: "Hello " },
        { type: "text_delta", text: "world!" },
        { type: "agent_end", messages: [] },
      ]);
      mockAgent.clearMessages = vi.fn();
      vi.mocked(agentManager.get).mockReturnValue(mockAgent);

      const { status, events } = await requestSSE(getPort(), "POST", "/api/chat", {
        agentId: "major",
        message: "hi there",
      });

      expect(status).toBe(200);

      // First event should be session
      const sessionEvent = events.find((e) => e.event === "session");
      expect(sessionEvent).toBeDefined();
      expect((sessionEvent!.data as { sessionId: string }).sessionId).toBeTruthy();

      // Should have text_delta events
      const textDeltas = events.filter((e) => e.event === "text_delta");
      expect(textDeltas).toHaveLength(2);
      expect((textDeltas[0].data as { text: string }).text).toBe("Hello ");
      expect((textDeltas[1].data as { text: string }).text).toBe("world!");

      // Should have done event
      const doneEvent = events.find((e) => e.event === "done");
      expect(doneEvent).toBeDefined();
    });

    it("streams tool_call and tool_result events", async () => {
      const mockAgent = createMockAgentInstance([
        { type: "tool_call", id: "tc1", name: "echo", args: { text: "hi" } },
        { type: "tool_result", id: "tc1", output: "hi" },
        { type: "text_delta", text: "Done." },
        { type: "agent_end", messages: [] },
      ]);
      mockAgent.clearMessages = vi.fn();
      vi.mocked(agentManager.get).mockReturnValue(mockAgent);

      const { events } = await requestSSE(getPort(), "POST", "/api/chat", {
        agentId: "major",
        message: "use echo",
      });

      const toolCall = events.find((e) => e.event === "tool_call");
      expect(toolCall).toBeDefined();
      expect((toolCall!.data as { name: string }).name).toBe("echo");

      const toolResult = events.find((e) => e.event === "tool_result");
      expect(toolResult).toBeDefined();
      expect((toolResult!.data as { output: string }).output).toBe("hi");
    });

    it("returns 404 for unknown sessionId", async () => {
      vi.mocked(sessionStore.get).mockResolvedValue(undefined);

      const { status, data } = await request(getPort(), "POST", "/api/chat", {
        agentId: "major",
        sessionId: "nonexistent",
        message: "hello",
      });
      expect(status).toBe(404);
      expect((data as { error: string }).error).toContain("nonexistent");
    });
  });
});
