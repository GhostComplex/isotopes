// src/transports/discord.test.ts — Unit tests for DiscordTransport

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiscordTransport } from "./discord.js";
import type { AgentManager, SessionStore, AgentInstance } from "../core/types.js";

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

type MockChannel = {
  sendTyping: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

// ---------------------------------------------------------------------------
// Mock discord.js
// ---------------------------------------------------------------------------

vi.mock("discord.js", () => {
  const mockClient = {
    on: vi.fn(),
    login: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    user: { id: "bot-123", tag: "TestBot#0001" },
  };

  return {
    Client: vi.fn(() => mockClient),
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      DirectMessages: 4,
      MessageContent: 8,
    },
    Partials: {
      Channel: 1,
      Message: 2,
    },
  };
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockAgentManager(): AgentManager {
  const mockInstance: AgentInstance = {
    prompt: vi.fn(async function* () {
      yield { type: "text_delta" as const, text: "Hello " };
      yield { type: "text_delta" as const, text: "world!" };
      yield { type: "agent_end" as const, messages: [] };
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
  };

  return {
    create: vi.fn(),
    get: vi.fn(() => mockInstance),
    list: vi.fn(() => []),
    update: vi.fn(),
    delete: vi.fn(),
    getPrompt: vi.fn(),
    updatePrompt: vi.fn(),
  };
}

function createMockSessionStore(): SessionStore {
  return {
    create: vi.fn().mockResolvedValue({
      id: "session-123",
      agentId: "default",
      lastActiveAt: new Date(),
    }),
    get: vi.fn(),
    addMessage: vi.fn(),
    getMessages: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiscordTransport", () => {
  let transport: DiscordTransport;
  let agentManager: AgentManager;
  let sessionStore: SessionStore;

  beforeEach(() => {
    vi.clearAllMocks();
    agentManager = createMockAgentManager();
    sessionStore = createMockSessionStore();
    transport = new DiscordTransport({
      token: "test-token",
      agentManager,
      sessionStore,
      defaultAgentId: "default",
    });
  });

  describe("start", () => {
    it("logs in to Discord", async () => {
      await transport.start();

      const { Client } = await import("discord.js");
      const mockClient = (Client as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

      expect(mockClient.login).toHaveBeenCalledWith("test-token");
    });

    it("registers message handler", async () => {
      await transport.start();

      const { Client } = await import("discord.js");
      const mockClient = (Client as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

      expect(mockClient.on).toHaveBeenCalledWith("ready", expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith("messageCreate", expect.any(Function));
    });
  });

  describe("stop", () => {
    it("destroys the client", async () => {
      await transport.start();
      await transport.stop();

      const { Client } = await import("discord.js");
      const mockClient = (Client as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

      expect(mockClient.destroy).toHaveBeenCalled();
    });
  });

  describe("message chunking", () => {
    it("chunks long messages correctly", () => {
      // Access private method via prototype
      const chunkMessage = (transport as unknown as { chunkMessage: (s: string, n?: number) => string[] }).chunkMessage.bind(transport);

      const shortMsg = "Hello world";
      expect(chunkMessage(shortMsg)).toEqual(["Hello world"]);

      const longMsg = "a".repeat(3000);
      const chunks = chunkMessage(longMsg);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c) => c.length <= 2000)).toBe(true);
    });
  });

  describe("runAgentAndRespond", () => {
    it("logs and sends a message when agent_end reports an error", async () => {
      const erroringAgent: AgentInstance = {
        prompt: vi.fn(async function* () {
          yield {
            type: "agent_end" as const,
            messages: [],
            stopReason: "error",
            errorMessage: "No API provider registered for api: undefined",
          };
        }),
        abort: vi.fn(),
        steer: vi.fn(),
        followUp: vi.fn(),
      };

      const channel: MockChannel = {
        sendTyping: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue({}),
      };

      await (
        transport as unknown as {
          runAgentAndRespond: (
            agent: AgentInstance,
            input: string,
            channel: MockChannel,
            sessionId: string,
          ) => Promise<void>;
        }
      ).runAgentAndRespond(erroringAgent, "hello", channel, "session-123");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Agent ended with error: No API provider registered for api: undefined"),
      );
      expect(channel.send).toHaveBeenCalledWith(
        "❌ No API provider registered for api: undefined",
      );
      expect(sessionStore.addMessage).toHaveBeenCalledWith(
        "session-123",
        expect.objectContaining({
          role: "assistant",
          content: "❌ No API provider registered for api: undefined",
          metadata: { isError: true },
        }),
      );
    });
  });
});
