// src/commands/slash-commands.test.ts — Tests for slash command handler

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlashCommandHandler, type CommandContext } from "./slash-commands.js";
import { createMockAgentManager, createMockSessionStore } from "../core/test-helpers.js";

function createContext(overrides?: Partial<CommandContext>): CommandContext {
  return {
    agentManager: createMockAgentManager(),
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
      const agentManager = createMockAgentManager();
      (agentManager.list as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: "agent-1", systemPrompt: "", provider: { type: "anthropic", model: "claude-sonnet-4" } },
      ]);

      const sessionStore = createMockSessionStore();
      (sessionStore.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "s1", agentId: "agent-1", lastActiveAt: new Date() },
        { id: "s2", agentId: "agent-1", lastActiveAt: new Date() },
      ]);

      const ctx = createContext({ agentManager, sessionStore });
      const result = await handler.execute("/status", ctx);

      expect(result.response).toContain("Agent Status");
      expect(result.response).toContain("claude-sonnet-4");
      expect(result.response).toContain("agent-1");
      expect(result.response).toContain("Active sessions: 2");
    });

    it("shows default model when no provider configured", async () => {
      const agentManager = createMockAgentManager();
      (agentManager.list as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: "agent-1", systemPrompt: "" },
      ]);

      const ctx = createContext({ agentManager });
      const result = await handler.execute("/status", ctx);
      expect(result.response).toContain("claude-opus-4.5");
    });
  });

  // -----------------------------------------------------------------------
  // /reload
  // -----------------------------------------------------------------------

  describe("/reload", () => {
    it("calls reloadWorkspace and reports success", async () => {
      const agentManager = createMockAgentManager();
      (agentManager.reloadWorkspace as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const ctx = createContext({ agentManager });
      const result = await handler.execute("/reload", ctx);

      expect(agentManager.reloadWorkspace).toHaveBeenCalledWith("agent-1");
      expect(result.response).toContain("Workspace reloaded");
    });

    it("reports errors on reload failure", async () => {
      const agentManager = createMockAgentManager();
      (agentManager.reloadWorkspace as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("No workspace path"),
      );

      const ctx = createContext({ agentManager });
      const result = await handler.execute("/reload", ctx);

      expect(result.response).toContain("Reload failed");
      expect(result.response).toContain("No workspace path");
    });
  });

  // -----------------------------------------------------------------------
  // /model
  // -----------------------------------------------------------------------

  describe("/model", () => {
    it("shows current model when no args given", async () => {
      const agentManager = createMockAgentManager();
      (agentManager.list as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: "agent-1", systemPrompt: "", provider: { type: "anthropic", model: "claude-sonnet-4" } },
      ]);

      const ctx = createContext({ agentManager });
      const result = await handler.execute("/model", ctx);

      expect(result.response).toContain("Current model");
      expect(result.response).toContain("claude-sonnet-4");
    });

    it("switches model on agent", async () => {
      const agentManager = createMockAgentManager();
      (agentManager.list as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: "agent-1", systemPrompt: "", provider: { type: "anthropic", model: "claude-opus-4.5" } },
      ]);
      (agentManager.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const ctx = createContext({ agentManager });
      const result = await handler.execute("/model claude-sonnet-4", ctx);

      expect(agentManager.update).toHaveBeenCalledWith("agent-1", {
        provider: { type: "anthropic", model: "claude-sonnet-4" },
      });
      expect(result.response).toContain("Model switched");
      expect(result.response).toContain("claude-sonnet-4");
    });

    it("reports errors on invalid model", async () => {
      const agentManager = createMockAgentManager();
      (agentManager.list as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: "agent-1", systemPrompt: "" },
      ]);
      (agentManager.update as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Unknown anthropic model: fake-model"),
      );

      const ctx = createContext({ agentManager });
      const result = await handler.execute("/model fake-model", ctx);

      expect(result.response).toContain("Model switch failed");
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
