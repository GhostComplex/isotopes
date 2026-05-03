// src/commands/slash-commands.test.ts — Tests for slash command handler

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlashCommandHandler, type CommandContext } from "./slash-commands.js";
import { createMockSessionStore } from "../../test-helpers.js";
import type { AgentRuntime } from "../../agent/runtime.js";
import type { AgentConfig } from "../../agent/types.js";

interface FakeAgent {
  id: string;
  config: AgentConfig;
}

function fakeAgentRuntime(opts?: {
  agents?: FakeAgent[];
}): AgentRuntime {
  const agents = new Map<string, FakeAgent>();
  for (const a of opts?.agents ?? []) agents.set(a.id, a);
  return {
    getAgent: (id: string) => agents.get(id),
    listAgents: () => Array.from(agents.values()),
  } as unknown as AgentRuntime;
}

function createContext(overrides?: Partial<CommandContext>): CommandContext {
  return {
    agentRuntime: fakeAgentRuntime({ agents: [{ id: "agent-1", config: { id: "agent-1" } }] }),
    sessionStore: createMockSessionStore(),
    agentId: "agent-1",
    userId: "admin-123",
    username: "admin",
    ...overrides,
  };
}

describe("SlashCommandHandler", () => {
  let handler: SlashCommandHandler;

  beforeEach(() => {
    handler = new SlashCommandHandler(["admin-123"]);
  });

  // -----------------------------------------------------------------------
  // Parsing
  // -----------------------------------------------------------------------

  describe("parse", () => {
    it("parses /command", () => {
      expect(handler.parse("/status")).toEqual({ name: "status", args: "" });
    });

    it("parses !command", () => {
      expect(handler.parse("!reload")).toEqual({ name: "reload", args: "" });
    });

    it("parses command with args", () => {
      expect(handler.parse("/model claude-sonnet-4")).toEqual({
        name: "model",
        args: "claude-sonnet-4",
      });
    });

    it("normalizes command name to lowercase", () => {
      expect(handler.parse("/STATUS")).toEqual({ name: "status", args: "" });
    });

    it("trims whitespace", () => {
      expect(handler.parse("  /status  ")).toEqual({ name: "status", args: "" });
    });

    it("returns null for non-commands", () => {
      expect(handler.parse("hello")).toBeNull();
      expect(handler.parse("")).toBeNull();
    });

    it("returns null for bare prefix", () => {
      expect(handler.parse("/")).toBeNull();
      expect(handler.parse("!")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // isCommand
  // -----------------------------------------------------------------------

  describe("isCommand", () => {
    it("returns true for known commands", () => {
      expect(handler.isCommand("/status")).toBe(true);
      expect(handler.isCommand("/reload")).toBe(true);
      expect(handler.isCommand("/model gpt-4")).toBe(true);
      expect(handler.isCommand("!status")).toBe(true);
    });

    it("returns false for unknown commands", () => {
      expect(handler.isCommand("/unknown")).toBe(false);
      expect(handler.isCommand("/help")).toBe(false);
    });

    it("returns false for non-commands", () => {
      expect(handler.isCommand("hello")).toBe(false);
      expect(handler.isCommand("")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Admin check
  // -----------------------------------------------------------------------

  describe("admin authorization", () => {
    it("rejects non-admin users", async () => {
      const ctx = createContext({ userId: "non-admin-456", username: "nobody" });
      const result = await handler.execute("/status", ctx);
      expect(result.response).toContain("not authorized");
    });

    it("allows admin users", async () => {
      const ctx = createContext({ userId: "admin-123" });
      const result = await handler.execute("/status", ctx);
      expect(result.response).toContain("Agent Status");
    });
  });

  // -----------------------------------------------------------------------
  // /status
  // -----------------------------------------------------------------------

  describe("/status", () => {
    it("returns uptime, model, agent, and session info", async () => {
      const sessionStore = createMockSessionStore();
      (sessionStore.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "s1", agentId: "agent-1", lastActiveAt: new Date() },
        { id: "s2", agentId: "agent-1", lastActiveAt: new Date() },
      ]);

      const ctx = createContext({
        agentRuntime: fakeAgentRuntime({
          agents: [{ id: "agent-1", config: { id: "agent-1", model: "claude-sonnet-4" } }],
        }),
        sessionStore,
      });
      const result = await handler.execute("/status", ctx);

      expect(result.response).toContain("Agent Status");
      expect(result.response).toContain("claude-sonnet-4");
      expect(result.response).toContain("agent-1");
      expect(result.response).toContain("Active sessions: 2");
    });

    it("shows default model when no provider configured", async () => {
      const ctx = createContext();
      const result = await handler.execute("/status", ctx);
      expect(result.response).toContain("(default)");
    });
  });

  // -----------------------------------------------------------------------
  // /reload
  // -----------------------------------------------------------------------

  describe("/reload", () => {
    it("acknowledges the reload (workspace files reload automatically per-call)", async () => {
      const ctx = createContext();
      const result = await handler.execute("/reload", ctx);
      expect(result.response).toContain("reloaded automatically");
    });

    it("reports error when agent does not exist", async () => {
      const ctx = createContext({
        agentRuntime: fakeAgentRuntime({ agents: [] }),
      });
      const result = await handler.execute("/reload", ctx);
      expect(result.response).toContain("not found");
    });
  });

  // -----------------------------------------------------------------------
  // /model
  // -----------------------------------------------------------------------

  describe("/model", () => {
    it("shows current model when no args given", async () => {
      const ctx = createContext({
        agentRuntime: fakeAgentRuntime({
          agents: [{ id: "agent-1", config: { id: "agent-1", model: "claude-sonnet-4" } }],
        }),
      });
      const result = await handler.execute("/model", ctx);

      expect(result.response).toContain("Current model");
      expect(result.response).toContain("claude-sonnet-4");
    });

    it("switches model on agent", async () => {
      const agent = { id: "agent-1", config: { id: "agent-1", model: "claude-opus-4-5" } };
      const ctx = createContext({
        agentRuntime: fakeAgentRuntime({ agents: [agent] }),
      });
      const result = await handler.execute("/model claude-sonnet-4", ctx);

      expect(agent.config.model).toBe("claude-sonnet-4");
      expect(result.response).toContain("Model switched");
      expect(result.response).toContain("claude-sonnet-4");
    });

    it("reports error when agent does not exist", async () => {
      const ctx = createContext({
        agentRuntime: fakeAgentRuntime({ agents: [] }),
      });
      const result = await handler.execute("/model fake-model", ctx);
      expect(result.response).toContain("not found");
    });
  });

  // -----------------------------------------------------------------------
  // Unknown command
  // -----------------------------------------------------------------------

  describe("unknown commands", () => {
    it("returns unknown command response for known admin", async () => {
      const ctx = createContext();
      const result = await handler.execute("/foo", ctx);
      expect(result.response).toContain("Unknown command");
      expect(result.response).toContain("/foo");
    });
  });

  // -----------------------------------------------------------------------
  // /new and /reset
  // -----------------------------------------------------------------------

  describe("/new and /reset", () => {
    it("clears session messages and returns success", async () => {
      const sessionStore = createMockSessionStore();
      (sessionStore.clearMessages as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const ctx = createContext({
        sessionStore,
        sessionId: "session-123",
      });

      const result = await handler.execute("/new", ctx);

      expect(sessionStore.clearMessages).toHaveBeenCalledWith("session-123");
      expect(result.response).toContain("Session reset");
    });

    it("/reset works as alias for /new", async () => {
      const sessionStore = createMockSessionStore();
      (sessionStore.clearMessages as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const ctx = createContext({
        sessionStore,
        sessionId: "session-456",
      });

      const result = await handler.execute("/reset", ctx);

      expect(sessionStore.clearMessages).toHaveBeenCalledWith("session-456");
      expect(result.response).toContain("Session reset");
    });

    it("returns info message when no active session", async () => {
      const ctx = createContext({ sessionId: undefined });
      const result = await handler.execute("/new", ctx);
      expect(result.response).toContain("No active session to reset");
    });

    it("reports error on clearMessages failure", async () => {
      const sessionStore = createMockSessionStore();
      (sessionStore.clearMessages as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Session not found"),
      );

      const ctx = createContext({
        sessionStore,
        sessionId: "session-789",
      });

      const result = await handler.execute("/new", ctx);

      expect(result.response).toContain("Reset failed");
      expect(result.response).toContain("Session not found");
    });
  });

  // -----------------------------------------------------------------------
  // Invalid input
  // -----------------------------------------------------------------------

  describe("invalid input", () => {
    it("returns invalid command for unparseable input", async () => {
      const ctx = createContext();
      const result = await handler.execute("hello", ctx);
      expect(result.response).toBe("Invalid command.");
    });
  });
});
