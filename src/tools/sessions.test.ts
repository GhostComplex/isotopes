// src/tools/sessions.test.ts — Tests for ACP session tools

import { describe, it, expect, beforeEach } from "vitest";
import {
  createSessionsSpawnTool,
  createSessionsAnnounceTool,
  createSessionsSendTool,
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
  it("returns all three tools", () => {
    const ctx = createTestContext();
    const tools = createSessionTools(ctx);
    const names = tools.map((t) => t.tool.name);

    expect(names).toContain("sessions_spawn");
    expect(names).toContain("sessions_announce");
    expect(names).toContain("sessions_send");
    expect(tools).toHaveLength(3);
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
