// src/tools/sessions.test.ts — Tests for ACP session tools

import { describe, it, expect, beforeEach } from "vitest";
import {
  createSessionsSpawnTool,
  createSessionsAnnounceTool,
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
  it("returns both tools", () => {
    const ctx = createTestContext();
    const tools = createSessionTools(ctx);
    const names = tools.map((t) => t.tool.name);

    expect(names).toContain("sessions_spawn");
    expect(names).toContain("sessions_announce");
    expect(tools).toHaveLength(2);
  });
});
