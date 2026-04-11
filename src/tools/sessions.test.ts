// src/tools/sessions.test.ts — Tests for ACP session tools

import { describe, it, expect, beforeEach } from "vitest";
import {
  createSessionsSpawnTool,
  createSessionsAnnounceTool,
  createSessionsSendTool,
  createSessionsListTool,
  createSessionsHistoryTool,
  createSessionsYieldTool,
  createSessionsKillTool,
  createSessionsStatusTool,
  createSessionTools,
  type SessionsToolContext,
} from "./sessions.js";
import { AcpSessionManager } from "../acp/session-manager.js";
import { AgentMessageBus } from "../acp/message-bus.js";
import type { AcpConfig } from "../acp/types.js";

function createTestContext(overrides?: Partial<SessionsToolContext>): SessionsToolContext {
  const config: AcpConfig = {
    enabled: true,
    backend: "acpx",
    defaultAgent: "agent-a",
    allowedAgents: ["agent-a", "agent-b", "agent-c"],
  };
  const sessionManager = new AcpSessionManager(config);
  const messageBus = new AgentMessageBus(sessionManager);

  return {
    sessionManager,
    messageBus,
    currentAgentId: "agent-a",
    currentSessionId: "session-001",
    ...overrides,
  };
}

describe("sessions_spawn", () => {
  let ctx: SessionsToolContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it("returns tool with correct schema", () => {
    const { tool } = createSessionsSpawnTool(ctx);
    expect(tool.name).toBe("sessions_spawn");
    expect(tool.parameters.required).toContain("target_agent_id");
  });

  it("spawns session for allowed agent", async () => {
    const { handler } = createSessionsSpawnTool(ctx);
    const result = JSON.parse(await handler({ target_agent_id: "agent-b" }));

    expect(result.session_id).toBeDefined();
    expect(result.agent_id).toBe("agent-b");
    expect(result.status).toBe("active");
  });

  it("spawns session with thread binding", async () => {
    const { handler } = createSessionsSpawnTool(ctx);
    const result = JSON.parse(
      await handler({ target_agent_id: "agent-b", thread_id: "thread-123" }),
    );

    expect(result.session_id).toBeDefined();
    expect(result.agent_id).toBe("agent-b");
    expect(result.status).toBe("active");

    // Verify session is bound to thread
    const session = ctx.sessionManager.getSessionByThread("thread-123");
    expect(session).toBeDefined();
    expect(session!.agentId).toBe("agent-b");
  });

  it("rejects spawn for agent not in allowedAgents", async () => {
    const { handler } = createSessionsSpawnTool(ctx);
    const result = JSON.parse(await handler({ target_agent_id: "agent-unknown" }));

    expect(result.error).toContain("not in the allowedAgents list");
  });

  it("rejects spawn for self", async () => {
    const { handler } = createSessionsSpawnTool(ctx);
    const result = JSON.parse(await handler({ target_agent_id: "agent-a" }));

    expect(result.error).toContain("Cannot spawn a session for yourself");
  });
});

describe("sessions_announce", () => {
  let ctx: SessionsToolContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it("returns tool with correct schema", () => {
    const { tool } = createSessionsAnnounceTool(ctx);
    expect(tool.name).toBe("sessions_announce");
    expect(tool.parameters.required).toContain("content");
  });

  it("sends message to specific agent", async () => {
    // Subscribe a handler so message is delivered
    const received: unknown[] = [];
    ctx.messageBus.subscribe("agent-b", (msg) => {
      received.push(msg);
    });

    const { handler } = createSessionsAnnounceTool(ctx);
    const result = JSON.parse(
      await handler({ content: "hello agent-b", to_agent_id: "agent-b" }),
    );

    expect(result.message_id).toBeDefined();
    expect(result.delivered).toBe(true);
    expect(result.recipients).toBe(1);
    expect(received).toHaveLength(1);
  });

  it("sends message to specific session", async () => {
    // Create a session and subscribe to it
    const session = ctx.sessionManager.createSession("agent-b");
    const received: unknown[] = [];
    ctx.messageBus.subscribeSession(session.id, (msg) => {
      received.push(msg);
    });

    const { handler } = createSessionsAnnounceTool(ctx);
    const result = JSON.parse(
      await handler({
        content: "hello session",
        to_agent_id: "agent-b",
        to_session_id: session.id,
      }),
    );

    expect(result.delivered).toBe(true);
    expect(result.recipients).toBe(1);
    expect(received).toHaveLength(1);
  });

  it("broadcasts to all agents", async () => {
    // Subscribe handlers for two other agents
    const receivedB: unknown[] = [];
    const receivedC: unknown[] = [];
    ctx.messageBus.subscribe("agent-b", (msg) => { receivedB.push(msg); });
    ctx.messageBus.subscribe("agent-c", (msg) => { receivedC.push(msg); });

    const { handler } = createSessionsAnnounceTool(ctx);
    const result = JSON.parse(await handler({ content: "hello everyone" }));

    expect(result.delivered).toBe(true);
    expect(result.recipients).toBe(2);
    expect(receivedB).toHaveLength(1);
    expect(receivedC).toHaveLength(1);
  });

  it("rejects empty content", async () => {
    const { handler } = createSessionsAnnounceTool(ctx);
    const result = JSON.parse(await handler({ content: "" }));

    expect(result.error).toContain("must not be empty");
  });

  it("rejects whitespace-only content", async () => {
    const { handler } = createSessionsAnnounceTool(ctx);
    const result = JSON.parse(await handler({ content: "   " }));

    expect(result.error).toContain("must not be empty");
  });

  it("rejects to_session_id without to_agent_id", async () => {
    const { handler } = createSessionsAnnounceTool(ctx);
    const result = JSON.parse(
      await handler({ content: "hello", to_session_id: "session-123" }),
    );

    expect(result.error).toContain("to_session_id requires to_agent_id");
  });

  it("queues message when no handler is subscribed", async () => {
    const { handler } = createSessionsAnnounceTool(ctx);
    const result = JSON.parse(
      await handler({ content: "hello offline", to_agent_id: "agent-b" }),
    );

    expect(result.message_id).toBeDefined();
    expect(result.delivered).toBe(false);
    expect(result.recipients).toBe(0);

    // Message should be pending
    const pending = ctx.messageBus.getPending("agent-b");
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe("hello offline");
  });

  it("returns zero recipients on empty broadcast", async () => {
    // No agents subscribed — broadcast finds no handlers
    const { handler } = createSessionsAnnounceTool(ctx);
    const result = JSON.parse(await handler({ content: "anyone there?" }));

    expect(result.delivered).toBe(false);
    expect(result.recipients).toBe(0);
  });
});

describe("createSessionTools", () => {
  it("returns all eight tools", () => {
    const ctx = createTestContext();
    const tools = createSessionTools(ctx);
    const names = tools.map((t) => t.tool.name);

    expect(names).toContain("sessions_spawn");
    expect(names).toContain("sessions_announce");
    expect(names).toContain("sessions_send");
    expect(names).toContain("sessions_list");
    expect(names).toContain("sessions_history");
    expect(names).toContain("sessions_yield");
    expect(names).toContain("sessions_kill");
    expect(names).toContain("sessions_status");
    expect(tools).toHaveLength(8);
  });
});

describe("sessions_send", () => {
  let ctx: SessionsToolContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it("returns tool with correct schema", () => {
    const { tool } = createSessionsSendTool(ctx);
    expect(tool.name).toBe("sessions_send");
    expect(tool.parameters.required).toContain("to_agent_id");
    expect(tool.parameters.required).toContain("content");
  });

  it("sends message to agent successfully", async () => {
    const received: unknown[] = [];
    ctx.messageBus.subscribe("agent-b", (msg) => {
      received.push(msg);
    });

    const { handler } = createSessionsSendTool(ctx);
    const result = JSON.parse(
      await handler({ to_agent_id: "agent-b", content: "hello direct" }),
    );

    expect(result.message_id).toBeDefined();
    expect(result.delivered).toBe(true);
    expect(received).toHaveLength(1);
  });

  it("sends message to specific session", async () => {
    const session = ctx.sessionManager.createSession("agent-b");
    const received: unknown[] = [];
    ctx.messageBus.subscribeSession(session.id, (msg) => {
      received.push(msg);
    });

    const { handler } = createSessionsSendTool(ctx);
    const result = JSON.parse(
      await handler({
        to_agent_id: "agent-b",
        to_session_id: session.id,
        content: "hello session",
      }),
    );

    expect(result.delivered).toBe(true);
    expect(received).toHaveLength(1);
  });

  it("returns reply when expect_reply receives correlated response", async () => {
    // Subscribe to agent-b and auto-reply with correlation_id
    ctx.messageBus.subscribe("agent-b", (msg) => {
      ctx.messageBus.send({
        fromAgentId: "agent-b",
        toAgentId: msg.fromAgentId,
        content: "reply content",
        metadata: { correlation_id: msg.id },
      });
    });

    const { handler } = createSessionsSendTool(ctx);
    const result = JSON.parse(
      await handler({
        to_agent_id: "agent-b",
        content: "need a reply",
        expect_reply: true,
      }),
    );

    expect(result.message_id).toBeDefined();
    expect(result.delivered).toBe(true);
    expect(result.reply).toBe("reply content");
    expect(result.reply_metadata).toBeDefined();
    expect(result.reply_metadata.correlation_id).toBe(result.message_id);
  });

  it("returns null reply on expect_reply timeout", async () => {
    // Subscribe to agent-b but do NOT reply — will timeout
    ctx.messageBus.subscribe("agent-b", () => {
      // intentionally no reply
    });

    const { handler } = createSessionsSendTool(ctx);

    const start = Date.now();
    const result = JSON.parse(
      await handler({
        to_agent_id: "agent-b",
        content: "waiting for reply",
        expect_reply: true,
      }),
    );
    const elapsed = Date.now() - start;

    expect(result.delivered).toBe(true);
    expect(result.reply).toBeNull();
    expect(result.reply_metadata).toBeNull();
    // Should have waited for the timeout (30s)
    expect(elapsed).toBeGreaterThanOrEqual(29_000);
  }, 35_000);

  it("returns error on self-send with expect_reply", async () => {
    const { handler } = createSessionsSendTool(ctx);
    const result = JSON.parse(
      await handler({
        to_agent_id: "agent-a",
        content: "talking to myself",
        expect_reply: true,
      }),
    );

    expect(result.error).toContain("deadlock");
  });

  it("allows self-send without expect_reply", async () => {
    const received: unknown[] = [];
    ctx.messageBus.subscribe("agent-a", (msg) => {
      received.push(msg);
    });

    const { handler } = createSessionsSendTool(ctx);
    const result = JSON.parse(
      await handler({ to_agent_id: "agent-a", content: "self note" }),
    );

    expect(result.message_id).toBeDefined();
    expect(result.delivered).toBe(true);
    expect(received).toHaveLength(1);
  });

  it("rejects empty content", async () => {
    const { handler } = createSessionsSendTool(ctx);
    const result = JSON.parse(
      await handler({ to_agent_id: "agent-b", content: "" }),
    );

    expect(result.error).toContain("must not be empty");
  });

  it("rejects whitespace-only content", async () => {
    const { handler } = createSessionsSendTool(ctx);
    const result = JSON.parse(
      await handler({ to_agent_id: "agent-b", content: "   " }),
    );

    expect(result.error).toContain("must not be empty");
  });

  it("queues message when no handler is subscribed", async () => {
    const { handler } = createSessionsSendTool(ctx);
    const result = JSON.parse(
      await handler({ to_agent_id: "agent-b", content: "hello offline" }),
    );

    expect(result.message_id).toBeDefined();
    expect(result.delivered).toBe(false);

    const pending = ctx.messageBus.getPending("agent-b");
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe("hello offline");
  });
});

describe("sessions_list", () => {
  let ctx: SessionsToolContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it("returns tool with correct schema", () => {
    const { tool } = createSessionsListTool(ctx);
    expect(tool.name).toBe("sessions_list");
    expect(tool.parameters.properties).toHaveProperty("agent_id");
    expect(tool.parameters.properties).toHaveProperty("status");
    expect(tool.parameters.properties).toHaveProperty("limit");
  });

  it("lists all sessions with no filter", async () => {
    ctx.sessionManager.createSession("agent-a");
    ctx.sessionManager.createSession("agent-b");
    ctx.sessionManager.createSession("agent-c");

    const { handler } = createSessionsListTool(ctx);
    const result = JSON.parse(await handler({}));

    expect(result.sessions).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.sessions[0]).toHaveProperty("session_id");
    expect(result.sessions[0]).toHaveProperty("agent_id");
    expect(result.sessions[0]).toHaveProperty("status");
    expect(result.sessions[0]).toHaveProperty("created_at");
    expect(result.sessions[0]).toHaveProperty("last_activity");
  });

  it("filters by agent_id (allowed)", async () => {
    ctx.sessionManager.createSession("agent-a");
    ctx.sessionManager.createSession("agent-b");
    ctx.sessionManager.createSession("agent-b");

    const { handler } = createSessionsListTool(ctx);
    const result = JSON.parse(await handler({ agent_id: "agent-b" }));

    expect(result.sessions).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.sessions.every((s: { agent_id: string }) => s.agent_id === "agent-b")).toBe(true);
  });

  it("rejects agent_id not in allowedAgents", async () => {
    const { handler } = createSessionsListTool(ctx);
    const result = JSON.parse(await handler({ agent_id: "agent-unknown" }));

    expect(result.error).toContain("Cannot query sessions for agent");
  });

  it("filters by status", async () => {
    const s1 = ctx.sessionManager.createSession("agent-a");
    ctx.sessionManager.createSession("agent-b");
    ctx.sessionManager.terminateSession(s1.id);

    const { handler } = createSessionsListTool(ctx);
    const result = JSON.parse(await handler({ status: "terminated" }));

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].status).toBe("terminated");
  });

  it("filters by both agent_id and status", async () => {
    const s1 = ctx.sessionManager.createSession("agent-b");
    ctx.sessionManager.createSession("agent-b");
    ctx.sessionManager.terminateSession(s1.id);

    const { handler } = createSessionsListTool(ctx);
    const result = JSON.parse(
      await handler({ agent_id: "agent-b", status: "active" }),
    );

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].status).toBe("active");
    expect(result.sessions[0].agent_id).toBe("agent-b");
  });

  it("enforces limit (default 20)", async () => {
    for (let i = 0; i < 25; i++) {
      ctx.sessionManager.createSession("agent-a");
    }

    const { handler } = createSessionsListTool(ctx);
    const result = JSON.parse(await handler({}));

    expect(result.sessions).toHaveLength(20);
    expect(result.total).toBe(25);
  });

  it("enforces max limit of 100", async () => {
    const { handler } = createSessionsListTool(ctx);
    const result = JSON.parse(await handler({ limit: 999 }));

    // Should be clamped to 100 (no sessions exist, but limit is enforced)
    expect(result.sessions).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("respects custom limit", async () => {
    for (let i = 0; i < 10; i++) {
      ctx.sessionManager.createSession("agent-a");
    }

    const { handler } = createSessionsListTool(ctx);
    const result = JSON.parse(await handler({ limit: 3 }));

    expect(result.sessions).toHaveLength(3);
    expect(result.total).toBe(10);
  });

  it("returns ISO timestamps", async () => {
    ctx.sessionManager.createSession("agent-a");

    const { handler } = createSessionsListTool(ctx);
    const result = JSON.parse(await handler({}));

    // Verify timestamps are valid ISO strings
    const createdAt = new Date(result.sessions[0].created_at);
    const lastActivity = new Date(result.sessions[0].last_activity);
    expect(createdAt.toISOString()).toBe(result.sessions[0].created_at);
    expect(lastActivity.toISOString()).toBe(result.sessions[0].last_activity);
  });
});

describe("sessions_history", () => {
  let ctx: SessionsToolContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it("returns tool with correct schema", () => {
    const { tool } = createSessionsHistoryTool(ctx);
    expect(tool.name).toBe("sessions_history");
    expect(tool.parameters.required).toContain("session_id");
    expect(tool.parameters.properties).toHaveProperty("limit");
    expect(tool.parameters.properties).toHaveProperty("before");
  });

  it("reads history from own session", async () => {
    const session = ctx.sessionManager.createSession("agent-a");
    ctx.sessionManager.addMessage(session.id, { role: "user", content: "hello" });
    ctx.sessionManager.addMessage(session.id, { role: "assistant", content: "hi there" });

    const { handler } = createSessionsHistoryTool(ctx);
    const result = JSON.parse(await handler({ session_id: session.id }));

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("hello");
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[1].content).toBe("hi there");
    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeUndefined();
  });

  it("reads history from allowed agent's session", async () => {
    const session = ctx.sessionManager.createSession("agent-b");
    ctx.sessionManager.addMessage(session.id, { role: "user", content: "test" });

    const { handler } = createSessionsHistoryTool(ctx);
    const result = JSON.parse(await handler({ session_id: session.id }));

    // agent-b is in allowedAgents, so agent-a can read it
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("test");
  });

  it("denies access to non-allowed agent's session", async () => {
    // Use a manager with empty allowedAgents so no agent is "allowed"
    const mgr = new AcpSessionManager({
      enabled: true,
      backend: "acpx",
      defaultAgent: "agent-a",
      allowedAgents: [],
    });
    const sess = mgr.createSession("agent-x");
    mgr.addMessage(sess.id, { role: "user", content: "secret" });

    // agent-a is not the owner (agent-x is), and agent-x is not in allowedAgents
    const restrictedCtx = createTestContext({
      sessionManager: mgr,
      currentAgentId: "agent-a",
    });

    const { handler } = createSessionsHistoryTool(restrictedCtx);
    const result = JSON.parse(await handler({ session_id: sess.id }));

    expect(result.error).toContain("Access denied");
  });

  it("returns error for non-existent session", async () => {
    const { handler } = createSessionsHistoryTool(ctx);
    const result = JSON.parse(await handler({ session_id: "non-existent" }));

    expect(result.error).toContain("Session not found");
  });

  it("paginates with before cursor", async () => {
    const session = ctx.sessionManager.createSession("agent-a");

    // Add messages with small delays to ensure distinct timestamps
    ctx.sessionManager.addMessage(session.id, { role: "user", content: "msg-1" });
    ctx.sessionManager.addMessage(session.id, { role: "assistant", content: "msg-2" });
    ctx.sessionManager.addMessage(session.id, { role: "user", content: "msg-3" });

    const { handler } = createSessionsHistoryTool(ctx);

    // First, get all messages to grab a cursor
    const allResult = JSON.parse(await handler({ session_id: session.id }));
    expect(allResult.messages).toHaveLength(3);

    // Use the last message's timestamp as a before cursor
    const cursor = allResult.messages[2].timestamp;
    const pagedResult = JSON.parse(
      await handler({ session_id: session.id, before: cursor }),
    );

    // Should only return messages before the cursor
    expect(pagedResult.messages.length).toBeLessThan(3);
    for (const msg of pagedResult.messages) {
      expect(new Date(msg.timestamp).getTime()).toBeLessThan(new Date(cursor).getTime());
    }
  });

  it("enforces default limit of 50", async () => {
    const session = ctx.sessionManager.createSession("agent-a");
    for (let i = 0; i < 60; i++) {
      ctx.sessionManager.addMessage(session.id, { role: "user", content: `msg-${i}` });
    }

    const { handler } = createSessionsHistoryTool(ctx);
    const result = JSON.parse(await handler({ session_id: session.id }));

    expect(result.messages).toHaveLength(50);
    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toBeDefined();
  });

  it("enforces max limit of 200", async () => {
    const session = ctx.sessionManager.createSession("agent-a");

    const { handler } = createSessionsHistoryTool(ctx);
    const result = JSON.parse(
      await handler({ session_id: session.id, limit: 999 }),
    );

    // No error — limit is clamped, just returns what's available
    expect(result.messages).toHaveLength(0);
    expect(result.has_more).toBe(false);
  });

  it("respects custom limit", async () => {
    const session = ctx.sessionManager.createSession("agent-a");
    for (let i = 0; i < 10; i++) {
      ctx.sessionManager.addMessage(session.id, { role: "user", content: `msg-${i}` });
    }

    const { handler } = createSessionsHistoryTool(ctx);
    const result = JSON.parse(
      await handler({ session_id: session.id, limit: 3 }),
    );

    expect(result.messages).toHaveLength(3);
    expect(result.has_more).toBe(true);
    // Should return the most recent 3 messages
    expect(result.messages[2].content).toBe("msg-9");
  });

  it("returns ISO timestamps in messages", async () => {
    const session = ctx.sessionManager.createSession("agent-a");
    ctx.sessionManager.addMessage(session.id, { role: "user", content: "test" });

    const { handler } = createSessionsHistoryTool(ctx);
    const result = JSON.parse(await handler({ session_id: session.id }));

    const ts = new Date(result.messages[0].timestamp);
    expect(ts.toISOString()).toBe(result.messages[0].timestamp);
  });

  it("sets next_cursor to first message timestamp when has_more", async () => {
    const session = ctx.sessionManager.createSession("agent-a");
    for (let i = 0; i < 5; i++) {
      ctx.sessionManager.addMessage(session.id, { role: "user", content: `msg-${i}` });
    }

    const { handler } = createSessionsHistoryTool(ctx);
    const result = JSON.parse(
      await handler({ session_id: session.id, limit: 3 }),
    );

    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toBe(result.messages[0].timestamp);
  });
});

describe("sessions_yield", () => {
  let ctx: SessionsToolContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it("returns tool with correct schema", () => {
    const { tool } = createSessionsYieldTool(ctx);
    expect(tool.name).toBe("sessions_yield");
    expect(tool.parameters.required).toContain("action");
    expect(tool.parameters.properties).toHaveProperty("session_id");
    expect(tool.parameters.properties).toHaveProperty("reason");
  });

  it("terminates own session", async () => {
    const session = ctx.sessionManager.createSession("agent-a");
    const yieldCtx = createTestContext({
      sessionManager: ctx.sessionManager,
      messageBus: ctx.messageBus,
      currentSessionId: session.id,
    });

    const { handler } = createSessionsYieldTool(yieldCtx);
    const result = JSON.parse(await handler({ action: "terminate" }));

    expect(result.success).toBe(true);
    expect(result.session_id).toBe(session.id);
    expect(result.previous_status).toBe("active");
    expect(result.new_status).toBe("terminated");

    // Verify session is actually terminated
    const updated = ctx.sessionManager.getSession(session.id);
    expect(updated?.status).toBe("terminated");
  });

  it("terminates session by explicit session_id", async () => {
    const session = ctx.sessionManager.createSession("agent-a");

    const { handler } = createSessionsYieldTool(ctx);
    const result = JSON.parse(
      await handler({ session_id: session.id, action: "terminate" }),
    );

    expect(result.success).toBe(true);
    expect(result.new_status).toBe("terminated");
  });

  it("pauses and resumes session", async () => {
    const session = ctx.sessionManager.createSession("agent-a");
    const yieldCtx = createTestContext({
      sessionManager: ctx.sessionManager,
      messageBus: ctx.messageBus,
      currentSessionId: session.id,
    });
    const { handler } = createSessionsYieldTool(yieldCtx);

    // Pause
    const pauseResult = JSON.parse(await handler({ action: "pause" }));
    expect(pauseResult.success).toBe(true);
    expect(pauseResult.previous_status).toBe("active");
    expect(pauseResult.new_status).toBe("paused");
    expect(ctx.sessionManager.getSession(session.id)?.status).toBe("paused");

    // Resume
    const resumeResult = JSON.parse(await handler({ action: "resume" }));
    expect(resumeResult.success).toBe(true);
    expect(resumeResult.previous_status).toBe("paused");
    expect(resumeResult.new_status).toBe("active");
    expect(ctx.sessionManager.getSession(session.id)?.status).toBe("active");
  });

  it("rejects resume on active session", async () => {
    const session = ctx.sessionManager.createSession("agent-a");
    const yieldCtx = createTestContext({
      sessionManager: ctx.sessionManager,
      messageBus: ctx.messageBus,
      currentSessionId: session.id,
    });
    const { handler } = createSessionsYieldTool(yieldCtx);

    const result = JSON.parse(await handler({ action: "resume" }));

    expect(result.success).toBe(false);
    expect(result.message).toContain("Cannot resume");
    expect(result.message).toContain("active");
  });

  it("rejects terminate on already terminated session", async () => {
    const session = ctx.sessionManager.createSession("agent-a");
    ctx.sessionManager.terminateSession(session.id);

    const { handler } = createSessionsYieldTool(ctx);
    const result = JSON.parse(
      await handler({ session_id: session.id, action: "terminate" }),
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("already terminated");
  });

  it("returns no-op success when pausing already paused session", async () => {
    const session = ctx.sessionManager.createSession("agent-a");
    ctx.sessionManager.updateSession(session.id, { status: "paused" });

    const { handler } = createSessionsYieldTool(ctx);
    const result = JSON.parse(
      await handler({ session_id: session.id, action: "pause" }),
    );

    expect(result.success).toBe(true);
    expect(result.previous_status).toBe("paused");
    expect(result.new_status).toBe("paused");
  });

  it("rejects access to other agent's session without permission", async () => {
    // Create a restricted context with no allowed agents
    const mgr = new AcpSessionManager({
      enabled: true,
      backend: "acpx",
      defaultAgent: "agent-a",
      allowedAgents: [],
    });
    const session = mgr.createSession("agent-x");

    const restrictedCtx = createTestContext({
      sessionManager: mgr,
      currentAgentId: "agent-a",
    });

    const { handler } = createSessionsYieldTool(restrictedCtx);
    const result = JSON.parse(
      await handler({ session_id: session.id, action: "terminate" }),
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("Access denied");
  });

  it("allows access to permitted agent's session", async () => {
    // agent-b is in allowedAgents, so agent-a can yield agent-b's session
    const session = ctx.sessionManager.createSession("agent-b");

    const { handler } = createSessionsYieldTool(ctx);
    const result = JSON.parse(
      await handler({ session_id: session.id, action: "terminate" }),
    );

    expect(result.success).toBe(true);
    expect(result.new_status).toBe("terminated");
  });

  it("returns error when no session_id and no current session", async () => {
    const noSessionCtx = createTestContext({ currentSessionId: undefined });
    const { handler } = createSessionsYieldTool(noSessionCtx);

    const result = JSON.parse(await handler({ action: "terminate" }));

    expect(result.success).toBe(false);
    expect(result.message).toContain("No session_id");
  });

  it("returns error for non-existent session", async () => {
    const { handler } = createSessionsYieldTool(ctx);
    const result = JSON.parse(
      await handler({ session_id: "non-existent", action: "terminate" }),
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("Session not found");
  });

  it("terminates paused session", async () => {
    const session = ctx.sessionManager.createSession("agent-a");
    ctx.sessionManager.updateSession(session.id, { status: "paused" });

    const { handler } = createSessionsYieldTool(ctx);
    const result = JSON.parse(
      await handler({ session_id: session.id, action: "terminate" }),
    );

    expect(result.success).toBe(true);
    expect(result.previous_status).toBe("paused");
    expect(result.new_status).toBe("terminated");
  });
});

describe("sessions_kill", () => {
  let ctx: SessionsToolContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it("returns tool with correct schema", () => {
    const { tool } = createSessionsKillTool(ctx);
    expect(tool.name).toBe("sessions_kill");
    expect(tool.parameters.required).toContain("session_id");
    expect(tool.parameters.properties).toHaveProperty("reason");
  });

  it("terminates an active session", async () => {
    const session = ctx.sessionManager.createSession("agent-a");

    const { handler } = createSessionsKillTool(ctx);
    const result = JSON.parse(await handler({ session_id: session.id }));

    expect(result.success).toBe(true);
    expect(result.session_id).toBe(session.id);
    expect(result.status).toBe("terminated");
    expect(result.previous_status).toBe("active");

    // Verify session is actually terminated
    const updated = ctx.sessionManager.getSession(session.id);
    expect(updated?.status).toBe("terminated");
  });

  it("terminates a paused session", async () => {
    const session = ctx.sessionManager.createSession("agent-a");
    ctx.sessionManager.updateSession(session.id, { status: "paused" });

    const { handler } = createSessionsKillTool(ctx);
    const result = JSON.parse(await handler({ session_id: session.id }));

    expect(result.success).toBe(true);
    expect(result.previous_status).toBe("paused");
    expect(result.status).toBe("terminated");
  });

  it("returns success with message for already terminated session", async () => {
    const session = ctx.sessionManager.createSession("agent-a");
    ctx.sessionManager.terminateSession(session.id);

    const { handler } = createSessionsKillTool(ctx);
    const result = JSON.parse(await handler({ session_id: session.id }));

    expect(result.success).toBe(true);
    expect(result.status).toBe("terminated");
    expect(result.message).toContain("already terminated");
  });

  it("returns error for non-existent session", async () => {
    const { handler } = createSessionsKillTool(ctx);
    const result = JSON.parse(await handler({ session_id: "non-existent" }));

    expect(result.error).toContain("Session not found");
  });

  it("allows killing allowed agent's session", async () => {
    // agent-b is in allowedAgents, so agent-a can kill it
    const session = ctx.sessionManager.createSession("agent-b");

    const { handler } = createSessionsKillTool(ctx);
    const result = JSON.parse(await handler({ session_id: session.id }));

    expect(result.success).toBe(true);
    expect(result.status).toBe("terminated");
  });

  it("rejects access to non-allowed agent's session", async () => {
    const mgr = new AcpSessionManager({
      enabled: true,
      backend: "acpx",
      defaultAgent: "agent-a",
      allowedAgents: [],
    });
    const session = mgr.createSession("agent-x");

    const restrictedCtx = createTestContext({
      sessionManager: mgr,
      currentAgentId: "agent-a",
    });

    const { handler } = createSessionsKillTool(restrictedCtx);
    const result = JSON.parse(await handler({ session_id: session.id }));

    expect(result.error).toContain("Access denied");
  });

  it("accepts optional reason parameter", async () => {
    const session = ctx.sessionManager.createSession("agent-a");

    const { handler } = createSessionsKillTool(ctx);
    const result = JSON.parse(
      await handler({ session_id: session.id, reason: "stuck subagent" }),
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe("terminated");
  });
});

describe("sessions_status", () => {
  let ctx: SessionsToolContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it("returns tool with correct schema", () => {
    const { tool } = createSessionsStatusTool(ctx);
    expect(tool.name).toBe("sessions_status");
    expect(tool.parameters.required).toContain("session_id");
  });

  it("returns correct fields for active session", async () => {
    const session = ctx.sessionManager.createSession("agent-a");
    ctx.sessionManager.addMessage(session.id, { role: "user", content: "hello" });
    ctx.sessionManager.addMessage(session.id, { role: "assistant", content: "hi" });

    const { handler } = createSessionsStatusTool(ctx);
    const result = JSON.parse(await handler({ session_id: session.id }));

    expect(result.session_id).toBe(session.id);
    expect(result.agent_id).toBe("agent-a");
    expect(result.status).toBe("active");
    expect(result.message_count).toBe(2);
    expect(result.thread_id).toBeNull();
    // Verify timestamps are valid ISO strings
    expect(new Date(result.created_at).toISOString()).toBe(result.created_at);
    expect(new Date(result.last_activity).toISOString()).toBe(result.last_activity);
  });

  it("returns thread_id when session is bound to a thread", async () => {
    const session = ctx.sessionManager.createSession("agent-a", "thread-456");

    const { handler } = createSessionsStatusTool(ctx);
    const result = JSON.parse(await handler({ session_id: session.id }));

    expect(result.thread_id).toBe("thread-456");
  });

  it("returns status for terminated session", async () => {
    const session = ctx.sessionManager.createSession("agent-a");
    ctx.sessionManager.terminateSession(session.id);

    const { handler } = createSessionsStatusTool(ctx);
    const result = JSON.parse(await handler({ session_id: session.id }));

    expect(result.status).toBe("terminated");
  });

  it("returns error for non-existent session", async () => {
    const { handler } = createSessionsStatusTool(ctx);
    const result = JSON.parse(await handler({ session_id: "non-existent" }));

    expect(result.error).toContain("Session not found");
  });

  it("allows status of allowed agent's session", async () => {
    // agent-b is in allowedAgents
    const session = ctx.sessionManager.createSession("agent-b");

    const { handler } = createSessionsStatusTool(ctx);
    const result = JSON.parse(await handler({ session_id: session.id }));

    expect(result.session_id).toBe(session.id);
    expect(result.agent_id).toBe("agent-b");
    expect(result.status).toBe("active");
  });

  it("rejects access to non-allowed agent's session", async () => {
    const mgr = new AcpSessionManager({
      enabled: true,
      backend: "acpx",
      defaultAgent: "agent-a",
      allowedAgents: [],
    });
    const session = mgr.createSession("agent-x");

    const restrictedCtx = createTestContext({
      sessionManager: mgr,
      currentAgentId: "agent-a",
    });

    const { handler } = createSessionsStatusTool(restrictedCtx);
    const result = JSON.parse(await handler({ session_id: session.id }));

    expect(result.error).toContain("Access denied");
  });

  it("returns zero message_count for empty session", async () => {
    const session = ctx.sessionManager.createSession("agent-a");

    const { handler } = createSessionsStatusTool(ctx);
    const result = JSON.parse(await handler({ session_id: session.id }));

    expect(result.message_count).toBe(0);
  });
});
