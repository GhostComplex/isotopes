// src/transports/discord.test.ts — Unit tests for DiscordTransport

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiscordTransport } from "./discord.js";
import type { AgentManager, SessionStore, AgentInstance, ChannelsConfig } from "../core/types.js";
import { textContent } from "../core/types.js";
import { ThreadBindingManager } from "../core/thread-bindings.js";
import { createMockAgentManager, createMockAgentInstance, createMockSessionStore } from "../core/test-helpers.js";

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

type MockChannel = {
  sendTyping: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  isThread: ReturnType<typeof vi.fn>;
  type?: number;
};

type MockIncomingMessage = {
  author: { bot: boolean; username: string; id: string; displayName?: string };
  content: string;
  createdTimestamp: number;
  guild: { id: string } | null;
  channelId: string;
  channel: MockChannel;
  mentions: { has: ReturnType<typeof vi.fn> };
  thread?: undefined;
  id?: string;
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
      const erroringAgent = createMockAgentInstance([
        {
          type: "agent_end",
          messages: [],
          stopReason: "error",
          errorMessage: "No API provider registered for api: undefined",
        },
      ]);

      const channel: MockChannel = {
        sendTyping: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue({}),
        isThread: vi.fn().mockReturnValue(false),
      };

      await (
        transport as unknown as {
          runAgentAndRespond: (
            agent: AgentInstance,
            input: string,
            channel: MockChannel,
            sessionId: string,
            sessionStore: SessionStore,
          ) => Promise<void>;
        }
      ).runAgentAndRespond(erroringAgent, "hello", channel, "session-123", sessionStore);

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
          content: textContent("❌ No API provider registered for api: undefined"),
          metadata: { isError: true },
        }),
      );
    });
  });

  describe("session recovery", () => {
    it("rehydrates prior messages when an existing session is found", async () => {
      const agent = agentManager.get("default")!;
      const promptSpy = vi.spyOn(agent, "prompt");

      sessionStore.findByKey = vi.fn().mockResolvedValue({
        id: "session-123",
        agentId: "default",
        lastActiveAt: new Date(),
      });
      sessionStore.getMessages = vi.fn().mockResolvedValue([
        { role: "assistant", content: textContent("Previous reply") },
        { role: "user", content: textContent("hello again") },
      ]);

      const channel: MockChannel = {
        sendTyping: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue(undefined) }),
        isThread: vi.fn().mockReturnValue(false),
      };

      const msg: MockIncomingMessage = {
        author: { bot: false, username: "tester", id: "user-1" },
        content: "<@123456> hello again",
        createdTimestamp: Date.now(),
        guild: { id: "guild-1" },
        channelId: "channel-1",
        channel,
        mentions: { has: vi.fn((id: string) => id === "bot-123") },
        thread: undefined,
      };

      await (
        transport as unknown as {
          handleMessage: (message: MockIncomingMessage) => Promise<void>;
        }
      ).handleMessage(msg);

      expect(sessionStore.findByKey).toHaveBeenCalledWith("discord:bot-123:channel:channel-1:default");
      expect(sessionStore.addMessage).toHaveBeenNthCalledWith(
        1,
        "session-123",
        expect.objectContaining({ 
          role: "user", 
          content: [expect.objectContaining({
            type: "text",
            text: expect.stringContaining("hello again"),
          })],
        }),
      );
      expect(promptSpy).toHaveBeenCalledWith([
        { role: "assistant", content: textContent("Previous reply") },
        { role: "user", content: textContent("hello again") },
      ]);
    });
  });

  describe("requireMention integration", () => {
    function makeChannel(): MockChannel {
      return {
        sendTyping: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue(undefined) }),
        isThread: vi.fn().mockReturnValue(false),
      };
    }

    function makeMsg(overrides: Partial<MockIncomingMessage> = {}): MockIncomingMessage {
      return {
        author: { bot: false, username: "tester", id: "user-1" },
        content: "hello bot",
        createdTimestamp: Date.now(),
        guild: { id: "guild-1" },
        channelId: "channel-1",
        channel: makeChannel(),
        mentions: { has: vi.fn(() => false) },
        thread: undefined,
        ...overrides,
      };
    }

    it("responds without mention when requireMention=false for the guild", async () => {
      const channels: ChannelsConfig = {
        discord: {
          accounts: {
            testacct: {
              guilds: {
                "guild-1": { requireMention: false },
              },
            },
          },
        },
      };

      const transportWithMention = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        channels,
        accountId: "testacct",
      });

      const msg = makeMsg({
        mentions: { has: vi.fn(() => false) },
      });

      await (
        transportWithMention as unknown as {
          handleMessage: (message: MockIncomingMessage) => Promise<void>;
        }
      ).handleMessage(msg);

      // Agent should have been called (message was processed)
      const agent = agentManager.get("default")!;
      expect(agent.prompt).toHaveBeenCalled();
    });

    it("ignores messages without mention when requireMention=true (default)", async () => {
      const channels: ChannelsConfig = {
        discord: {
          accounts: {
            testacct: {
              guilds: {
                "guild-1": { requireMention: true },
              },
            },
          },
        },
      };

      const transportWithMention = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        channels,
        accountId: "testacct",
      });

      const msg = makeMsg({
        mentions: { has: vi.fn(() => false) },
      });

      await (
        transportWithMention as unknown as {
          handleMessage: (message: MockIncomingMessage) => Promise<void>;
        }
      ).handleMessage(msg);

      // Agent should NOT have been called
      const agent = agentManager.get("default")!;
      expect(agent.prompt).not.toHaveBeenCalled();
    });

    it("responds to mention even when requireMention=true", async () => {
      const channels: ChannelsConfig = {
        discord: {
          accounts: {
            testacct: {
              guilds: {
                "guild-1": { requireMention: true },
              },
            },
          },
        },
      };

      const transportWithMention = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        channels,
        accountId: "testacct",
      });

      const msg = makeMsg({
        content: "<@bot-123> hello",
        mentions: { has: vi.fn((id: string) => id === "bot-123") },
      });

      await (
        transportWithMention as unknown as {
          handleMessage: (message: MockIncomingMessage) => Promise<void>;
        }
      ).handleMessage(msg);

      const agent = agentManager.get("default")!;
      expect(agent.prompt).toHaveBeenCalled();
    });

    it("defaults to requireMention=true when no channels config provided", async () => {
      // Transport without channels config (original behavior)
      const msg = makeMsg({
        mentions: { has: vi.fn(() => false) },
      });

      await (
        transport as unknown as {
          handleMessage: (message: MockIncomingMessage) => Promise<void>;
        }
      ).handleMessage(msg);

      const agent = agentManager.get("default")!;
      expect(agent.prompt).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Thread bindings
  // ---------------------------------------------------------------------------

  describe("thread bindings", () => {
    it("registers threadCreate handler when threadBindings.enabled is true", async () => {
      const transportWithThreads = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        threadBindings: { enabled: true },
      });

      await transportWithThreads.start();

      const { Client } = await import("discord.js");
      const mockClient = (Client as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

      const threadCreateCalls = mockClient.on.mock.calls.filter(
        ([event]: [string]) => event === "threadCreate",
      );
      expect(threadCreateCalls).toHaveLength(1);
    });

    it("does NOT register threadCreate handler when threadBindings.enabled is false", async () => {
      const transportNoThreads = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        threadBindings: { enabled: false },
      });

      await transportNoThreads.start();

      const { Client } = await import("discord.js");
      const mockClient = (Client as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

      const threadCreateCalls = mockClient.on.mock.calls.filter(
        ([event]: [string]) => event === "threadCreate",
      );
      expect(threadCreateCalls).toHaveLength(0);
    });

    it("does NOT register threadCreate handler when threadBindings is not configured", async () => {
      // `transport` from beforeEach has no threadBindings config
      await transport.start();

      const { Client } = await import("discord.js");
      const mockClient = (Client as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

      const threadCreateCalls = mockClient.on.mock.calls.filter(
        ([event]: [string]) => event === "threadCreate",
      );
      expect(threadCreateCalls).toHaveLength(0);
    });

    it("creates a binding when a thread is created", async () => {
      const bindingManager = new ThreadBindingManager();
      const transportWithThreads = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "test-agent",
        threadBindings: { enabled: true },
        threadBindingManager: bindingManager,
      });

      await transportWithThreads.start();

      // Get the threadCreate handler
      const { Client } = await import("discord.js");
      const mockClient = (Client as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      const threadCreateHandler = mockClient.on.mock.calls.find(
        ([event]: [string]) => event === "threadCreate",
      )?.[1] as (thread: { id: string; parentId: string | null }) => void;

      expect(threadCreateHandler).toBeDefined();

      // Simulate thread creation
      threadCreateHandler({ id: "thread-999", parentId: "channel-42" });

      const binding = bindingManager.get("thread-999");
      expect(binding).toBeDefined();
      expect(binding!.threadId).toBe("thread-999");
      expect(binding!.parentChannelId).toBe("channel-42");
      expect(binding!.agentId).toBe("test-agent");
    });

    it("uses 'default' agentId when defaultAgentId is not configured", async () => {
      const bindingManager = new ThreadBindingManager();
      const transportWithThreads = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        threadBindings: { enabled: true },
        threadBindingManager: bindingManager,
      });

      await transportWithThreads.start();

      const { Client } = await import("discord.js");
      const mockClient = (Client as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      const threadCreateHandler = mockClient.on.mock.calls.find(
        ([event]: [string]) => event === "threadCreate",
      )?.[1] as (thread: { id: string; parentId: string | null }) => void;

      threadCreateHandler({ id: "thread-1", parentId: "channel-1" });

      const binding = bindingManager.get("thread-1");
      expect(binding!.agentId).toBe("default");
    });

    it("ignores threads without a parent channel", async () => {
      const bindingManager = new ThreadBindingManager();
      const transportWithThreads = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "test-agent",
        threadBindings: { enabled: true },
        threadBindingManager: bindingManager,
      });

      await transportWithThreads.start();

      const { Client } = await import("discord.js");
      const mockClient = (Client as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      const threadCreateHandler = mockClient.on.mock.calls.find(
        ([event]: [string]) => event === "threadCreate",
      )?.[1] as (thread: { id: string; parentId: string | null }) => void;

      threadCreateHandler({ id: "thread-orphan", parentId: null });

      expect(bindingManager.get("thread-orphan")).toBeUndefined();
      expect(bindingManager.size).toBe(0);
    });

    it("respects channelAllowlist — only binds threads in allowed channels", async () => {
      const bindingManager = new ThreadBindingManager();
      const transportWithThreads = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "test-agent",
        threadBindings: { enabled: true },
        threadBindingManager: bindingManager,
        channelAllowlist: ["channel-allowed"],
      });

      await transportWithThreads.start();

      const { Client } = await import("discord.js");
      const mockClient = (Client as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      const threadCreateHandler = mockClient.on.mock.calls.find(
        ([event]: [string]) => event === "threadCreate",
      )?.[1] as (thread: { id: string; parentId: string | null }) => void;

      // Thread in allowed channel — should bind
      threadCreateHandler({ id: "thread-ok", parentId: "channel-allowed" });
      expect(bindingManager.get("thread-ok")).toBeDefined();

      // Thread in disallowed channel — should not bind
      threadCreateHandler({ id: "thread-nope", parentId: "channel-other" });
      expect(bindingManager.get("thread-nope")).toBeUndefined();
    });

    it("exposes thread binding manager via getThreadBindingManager()", () => {
      const bindingManager = new ThreadBindingManager();
      const transportWithThreads = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        threadBindings: { enabled: true },
        threadBindingManager: bindingManager,
      });

      expect(transportWithThreads.getThreadBindingManager()).toBe(bindingManager);
    });

    it("creates a default ThreadBindingManager when none is provided", () => {
      const transportWithThreads = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        threadBindings: { enabled: true },
      });

      expect(transportWithThreads.getThreadBindingManager()).toBeInstanceOf(ThreadBindingManager);
    });
  });

  // ---------------------------------------------------------------------------
  // Slash command routing
  // ---------------------------------------------------------------------------

  describe("slash command routing", () => {
    function makeChannel(): MockChannel {
      return {
        sendTyping: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue(undefined) }),
        isThread: vi.fn().mockReturnValue(false),
      };
    }

    function makeMsg(overrides: Partial<MockIncomingMessage> = {}): MockIncomingMessage {
      return {
        author: { bot: false, username: "tester", id: "user-1" },
        content: "<@bot-123> hello bot",
        createdTimestamp: Date.now(),
        guild: { id: "guild-1" },
        channelId: "channel-1",
        channel: makeChannel(),
        mentions: { has: vi.fn((id: string) => id === "bot-123") },
        thread: undefined,
        id: `msg-${Date.now()}`,
        ...overrides,
      };
    }

    it("routes /status to command handler and sends response", async () => {
      const transportWithAdmin = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        adminUsers: ["111111"],
      });

      const channel = makeChannel();
      const msg = makeMsg({
        content: "<@999999> /status",
        author: { bot: false, username: "admin", id: "111111" },
        channel,
      });

      await (transportWithAdmin as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg);

      // Command response should be sent to the channel
      expect(channel.send).toHaveBeenCalledWith(expect.stringContaining("Agent Status"));

      // Agent should NOT have been called — command was intercepted
      const agent = agentManager.get("default")!;
      expect(agent.prompt).not.toHaveBeenCalled();
    });

    it("routes /reload to command handler", async () => {
      (agentManager.reloadWorkspace as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const transportWithAdmin = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        adminUsers: ["111111"],
      });

      const channel = makeChannel();
      const msg = makeMsg({
        content: "<@999999> /reload",
        author: { bot: false, username: "admin", id: "111111" },
        channel,
      });

      await (transportWithAdmin as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg);

      expect(agentManager.reloadWorkspace).toHaveBeenCalledWith("default");
      expect(channel.send).toHaveBeenCalledWith(expect.stringContaining("Workspace reloaded"));
      expect(agentManager.get("default")!.prompt).not.toHaveBeenCalled();
    });

    it("routes /model to command handler", async () => {
      (agentManager.list as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: "default", systemPrompt: "", provider: { type: "anthropic", model: "claude-sonnet-4" } },
      ]);

      const transportWithAdmin = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        adminUsers: ["111111"],
      });

      const channel = makeChannel();
      const msg = makeMsg({
        content: "<@999999> /model",
        author: { bot: false, username: "admin", id: "111111" },
        channel,
      });

      await (transportWithAdmin as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg);

      expect(channel.send).toHaveBeenCalledWith(expect.stringContaining("Current model"));
      expect(channel.send).toHaveBeenCalledWith(expect.stringContaining("claude-sonnet-4"));
      expect(agentManager.get("default")!.prompt).not.toHaveBeenCalled();
    });

    it("rejects non-admin users with authorization error", async () => {
      const transportWithAdmin = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        adminUsers: ["111111"],
      });

      const channel = makeChannel();
      const msg = makeMsg({
        content: "<@999999> /status",
        author: { bot: false, username: "normie", id: "222222" },
        channel,
      });

      await (transportWithAdmin as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg);

      // Should still send a response (the rejection message), not route to agent
      expect(channel.send).toHaveBeenCalledWith(expect.stringContaining("not authorized"));
      expect(agentManager.get("default")!.prompt).not.toHaveBeenCalled();
    });

    it("passes non-command messages through to agent", async () => {
      const transportWithAdmin = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        adminUsers: ["111111"],
      });

      const channel = makeChannel();
      const msg = makeMsg({
        content: "<@999999> hello world",
        author: { bot: false, username: "admin", id: "111111" },
        channel,
      });

      await (transportWithAdmin as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg);

      // Non-command message should reach the agent
      const agent = agentManager.get("default")!;
      expect(agent.prompt).toHaveBeenCalled();
    });

    it("ignores unknown slash commands and passes them to agent", async () => {
      const transportWithAdmin = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        adminUsers: ["111111"],
      });

      const channel = makeChannel();
      const msg = makeMsg({
        content: "<@999999> /unknown",
        author: { bot: false, username: "admin", id: "111111" },
        channel,
      });

      await (transportWithAdmin as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg);

      // Unknown commands are not intercepted — isCommand returns false
      const agent = agentManager.get("default")!;
      expect(agent.prompt).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Context management
  // ---------------------------------------------------------------------------

  describe("context management", () => {
    function makeChannel(): MockChannel {
      return {
        sendTyping: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue(undefined) }),
        isThread: vi.fn().mockReturnValue(false),
      };
    }

    function makeMsg(overrides: Partial<MockIncomingMessage> = {}): MockIncomingMessage {
      return {
        author: { bot: false, username: "tester", id: "user-1" },
        content: "<@bot-123> hello bot",
        createdTimestamp: Date.now(),
        guild: { id: "guild-1" },
        channelId: "channel-1",
        channel: makeChannel(),
        mentions: { has: vi.fn((id: string) => id === "bot-123") },
        thread: undefined,
        id: `msg-${Date.now()}`,
        ...overrides,
      };
    }

    it("records channel history for non-mention messages", async () => {
      const channels: ChannelsConfig = {
        discord: {
          accounts: {
            testacct: {
              guilds: { "guild-1": { requireMention: true } },
            },
          },
        },
      };

      const transportCtx = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        channels,
        accountId: "testacct",
      });

      // Send a message without mentioning the bot — should be recorded to channel history
      const msg = makeMsg({
        content: "just chatting",
        mentions: { has: vi.fn(() => false) },
      });

      await (transportCtx as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg);

      // Agent should NOT have been called
      const agent = agentManager.get("default")!;
      expect(agent.prompt).not.toHaveBeenCalled();
    });

    it("injects channel history into user message when bot is triggered", async () => {
      const transportMention = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        channels: {
          discord: {
            accounts: {
              testacct: {
                guilds: { "guild-1": { requireMention: true } },
              },
            },
          },
        },
        accountId: "testacct",
      });

      const handleMsg2 = (m: MockIncomingMessage) =>
        (transportMention as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(m);

      // Non-mention message — recorded to channel history
      await handleMsg2(makeMsg({
        content: "I think we should use Redis",
        mentions: { has: vi.fn(() => false) },
        id: "msg-1",
      }));

      // Now send a mention message — channel history should be consumed
      await handleMsg2(makeMsg({
        content: "<@bot-123> what do you think?",
        mentions: { has: vi.fn((id: string) => id === "bot-123") },
        id: "msg-2",
      }));

      // The user message stored in session should contain channel history context
      expect(sessionStore.addMessage).toHaveBeenCalled();
      const addedMessage = (sessionStore.addMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const messageText = addedMessage.content[0].text;
      expect(messageText).toContain("Chat messages since your last reply");
      expect(messageText).toContain("I think we should use Redis");
      expect(messageText).toContain("what do you think?");
    });

    it("deduplicates messages with the same ID", async () => {
      const transportCtx = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
      });

      const handleMessage = (m: MockIncomingMessage) =>
        (transportCtx as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(m);

      const msg1 = makeMsg({ id: "same-msg-id" });
      const msg2 = makeMsg({ id: "same-msg-id" });

      await handleMessage(msg1);
      await handleMessage(msg2);

      // Agent should only be called once (second message is a duplicate)
      const agent = agentManager.get("default")!;
      expect(agent.prompt).toHaveBeenCalledTimes(1);
    });

    it("calls preparePromptMessages instead of raw slice", async () => {
      const agent = agentManager.get("default")!;
      const promptSpy = vi.spyOn(agent, "prompt");

      // Provide messages that would be affected by limitHistoryTurns
      sessionStore.getMessages = vi.fn().mockResolvedValue([
        { role: "user", content: textContent("old") },
        { role: "assistant", content: textContent("old reply") },
        { role: "user", content: textContent("recent") },
        { role: "assistant", content: textContent("recent reply") },
        { role: "user", content: textContent("hello bot") },
      ]);

      const transportCtx = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        context: { historyTurns: 2 },
      });

      const msg = makeMsg({ id: "unique-msg" });
      await (transportCtx as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg);

      // Should have been called with truncated messages (last 2 user turns)
      expect(promptSpy).toHaveBeenCalled();
      const promptInput = promptSpy.mock.calls[0][0] as { role: string }[];
      // With historyTurns=2, only the last 2 user turns should be kept
      const userMessages = promptInput.filter(m => m.role === "user");
      expect(userMessages.length).toBeLessThanOrEqual(2);
    });
  });

  describe("inbound_meta injection", () => {
    function makeChannel(): MockChannel {
      return {
        sendTyping: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue(undefined) }),
        isThread: vi.fn().mockReturnValue(false),
      };
    }

    it("injects inbound_meta block for group chats", async () => {
      sessionStore.findByKey = vi.fn().mockResolvedValue(null);
      sessionStore.create = vi.fn().mockResolvedValue({ id: "session-1" });
      sessionStore.getMessages = vi.fn().mockResolvedValue([]);

      const msg: MockIncomingMessage = {
        author: { bot: false, username: "alice", id: "user-alice", displayName: "Alice" },
        content: "<@bot-123> Hello world",
        createdTimestamp: Date.now(),
        guild: { id: "guild-1" },
        channelId: "channel-1",
        channel: makeChannel(),
        mentions: { has: vi.fn((id: string) => id === "bot-123") },
        thread: undefined,
      };

      // Need to set up bindings via config
      const testTransport = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        channels: {
          discord: {
            accounts: {
              testacct: {
                guilds: {
                  "guild-1": { requireMention: true },
                },
              },
            },
          },
        },
        accountId: "testacct",
      });

      await (
        testTransport as unknown as {
          handleMessage: (message: MockIncomingMessage) => Promise<void>;
        }
      ).handleMessage(msg);

      const addMessageCall = (sessionStore.addMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(addMessageCall).toBeDefined();
      const userMessage = addMessageCall[1];
      const contentText = userMessage.content[0].text;

      // Verify inbound_meta block is present
      expect(contentText).toContain('<inbound_meta type="untrusted">');
      expect(contentText).toContain("<chat_type>group</chat_type>");
      expect(contentText).toContain("<sender_id>user-alice</sender_id>");
      expect(contentText).toContain("<sender_username>alice</sender_username>");
      // Verify user message is still there
      expect(contentText).toContain("Hello world");
    });

    it("injects direct chat_type for DMs", async () => {
      sessionStore.findByKey = vi.fn().mockResolvedValue(null);
      sessionStore.create = vi.fn().mockResolvedValue({ id: "session-1" });
      sessionStore.getMessages = vi.fn().mockResolvedValue([]);

      const testTransport = new DiscordTransport({
        token: "test-token",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        allowDMs: true,
      });

      const msg: MockIncomingMessage = {
        author: { bot: false, username: "bob", id: "user-bob" },
        content: "private message",
        createdTimestamp: Date.now(),
        guild: null, // DM has no guild
        channelId: "dm-channel",
        channel: { ...makeChannel(), type: 1 }, // DM channel type
        mentions: { has: vi.fn(() => false) },
        thread: undefined,
      };

      await (
        testTransport as unknown as {
          handleMessage: (message: MockIncomingMessage) => Promise<void>;
        }
      ).handleMessage(msg);

      const addMessageCall = (sessionStore.addMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(addMessageCall).toBeDefined();
      const userMessage = addMessageCall[1];
      const contentText = userMessage.content[0].text;

      expect(contentText).toContain("<chat_type>direct</chat_type>");
      expect(contentText).toContain("private message");
    });
  });

  describe("thread control", () => {
    function makeChannel(isThread = false): MockChannel {
      return {
        sendTyping: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue(undefined) }),
        isThread: vi.fn().mockReturnValue(isThread),
      };
    }

    function makeMsg(overrides: Partial<MockIncomingMessage & { channel: MockChannel }> = {}): MockIncomingMessage {
      return {
        author: { bot: false, username: "tester", id: "user-1" },
        content: "<@bot-123> hello",
        createdTimestamp: Date.now(),
        guild: { id: "guild-1" },
        channelId: "channel-1",
        channel: makeChannel(false),
        mentions: { has: vi.fn((id: string) => id === "bot-123") },
        id: `msg-${Date.now()}`,
        ...overrides,
      };
    }

    it("responds to thread messages by default (threads.respond undefined)", async () => {
      const localAgentManager = createMockAgentManager();
      const localSessionStore = createMockSessionStore();
      const localTransport = new DiscordTransport({
        token: "test-token",
        agentManager: localAgentManager,
        sessionStore: localSessionStore,
        defaultAgentId: "default",
      });

      await localTransport.start();
      const channel = makeChannel(true); // is a thread
      const msg = makeMsg({ channel });

      await (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg);

      // Should respond (send was called)
      expect(channel.send).toHaveBeenCalled();
    });

    it("does NOT respond in threads when threads.respond=false", async () => {
      const localAgentManager = createMockAgentManager();
      const localSessionStore = createMockSessionStore();
      const localTransport = new DiscordTransport({
        token: "test-token",
        agentManager: localAgentManager,
        sessionStore: localSessionStore,
        defaultAgentId: "default",
        threads: { respond: false },
      });

      await localTransport.start();
      const channel = makeChannel(true); // is a thread
      const msg = makeMsg({ channel });

      await (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg);

      // Should NOT respond
      expect(channel.send).not.toHaveBeenCalled();
    });

    it("still responds in regular channels when threads.respond=false", async () => {
      const localAgentManager = createMockAgentManager();
      const localSessionStore = createMockSessionStore();
      const localTransport = new DiscordTransport({
        token: "test-token",
        agentManager: localAgentManager,
        sessionStore: localSessionStore,
        defaultAgentId: "default",
        threads: { respond: false },
      });

      await localTransport.start();
      const channel = makeChannel(false); // NOT a thread
      const msg = makeMsg({ channel });

      await (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg);

      // Should respond in regular channel
      expect(channel.send).toHaveBeenCalled();
    });

    it("ignores thread messages completely when both respond=false and observe=false", async () => {
      const localAgentManager = createMockAgentManager();
      const localSessionStore = createMockSessionStore();
      const localTransport = new DiscordTransport({
        token: "test-token",
        agentManager: localAgentManager,
        sessionStore: localSessionStore,
        defaultAgentId: "default",
        threads: { respond: false, observe: false },
      });

      await localTransport.start();
      const channel = makeChannel(true); // is a thread
      const msg = makeMsg({ channel });

      await (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg);

      // Should NOT respond and NOT add to session store
      expect(channel.send).not.toHaveBeenCalled();
      expect(localSessionStore.addMessage).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Frozen context (pending message buffering during long tool calls)
  // ---------------------------------------------------------------------------

  describe("frozen context — pending message buffering", () => {
    function makeChannel(): MockChannel {
      return {
        sendTyping: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue(undefined) }),
        isThread: vi.fn().mockReturnValue(false),
      };
    }

    function makeMsg(overrides: Partial<MockIncomingMessage> = {}): MockIncomingMessage {
      return {
        author: { bot: false, username: "tester", id: "user-1" },
        content: "<@bot-123> hello",
        createdTimestamp: Date.now(),
        guild: { id: "guild-1" },
        channelId: "channel-1",
        channel: makeChannel(),
        mentions: { has: vi.fn((id: string) => id === "bot-123") },
        thread: undefined,
        id: `msg-${Date.now()}`,
        ...overrides,
      };
    }

    it("buffers messages when session is active (in-flight prompt)", async () => {
      const localAgentManager = createMockAgentManager();
      const localSessionStore = createMockSessionStore();

      // Create a promise that we can control to simulate a long-running agent
      let resolvePrompt: () => void;
      const promptWait = new Promise<void>((resolve) => { resolvePrompt = resolve; });

      // Agent that waits for our signal before completing
      const hangingAgent = {
        prompt: vi.fn(async function* () {
          yield { type: "text_delta" as const, text: "Working..." };
          await promptWait; // Wait here until we signal
          yield { type: "agent_end" as const, messages: [] };
        }),
        abort: vi.fn(),
        steer: vi.fn(),
        followUp: vi.fn(),
      };
      localAgentManager.get = vi.fn().mockReturnValue(hangingAgent);

      const localTransport = new DiscordTransport({
        token: "test-token",
        agentManager: localAgentManager,
        sessionStore: localSessionStore,
        defaultAgentId: "default",
      });

      await localTransport.start();

      // First message — starts the agent prompt (makes session active)
      const msg1 = makeMsg({ content: "<@bot-123> start work", id: "msg-1" });
      const handleMessagePromise = (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg1);

      // Wait for prompt to be initiated (give it time to mark session as active)
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Second message — should be buffered since session is active
      const msg2 = makeMsg({ content: "<@bot-123> are you done yet?", id: "msg-2" });
      await (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg2);

      // Agent should only be called once (second message was buffered)
      expect(hangingAgent.prompt).toHaveBeenCalledTimes(1);

      // Now signal the agent to complete
      resolvePrompt!();
      await handleMessagePromise;
    });

    it("persists drained pending messages to SessionStore (issue #371)", async () => {
      const localAgentManager = createMockAgentManager();
      const localSessionStore = createMockSessionStore();

      let resolveAgent: () => void;
      const agentWait = new Promise<void>((resolve) => { resolveAgent = resolve; });

      // Agent: emits text, waits, then turn_end (drain happens here) + agent_end
      const agent = {
        prompt: vi.fn(async function* () {
          yield { type: "text_delta" as const, text: "thinking..." };
          await agentWait;
          yield { type: "turn_end" as const, usage: undefined };
          yield { type: "agent_end" as const, messages: [] };
        }),
        abort: vi.fn(),
        steer: vi.fn(),
        followUp: vi.fn(),
      };
      localAgentManager.get = vi.fn().mockReturnValue(agent);

      const localTransport = new DiscordTransport({
        token: "test-token",
        agentManager: localAgentManager,
        sessionStore: localSessionStore,
        defaultAgentId: "default",
      });
      await localTransport.start();

      // msg1 triggers the agent (also persisted via the normal addMessage path)
      const t1 = 1700000000000;
      const msg1 = makeMsg({ content: "<@bot-123> hello", id: "msg-1", createdTimestamp: t1 });
      const inFlight = (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // msg2 and msg3 arrive while agent is busy → should be buffered
      const msg2 = makeMsg({
        content: "<@bot-123> follow-up two",
        id: "msg-2",
        createdTimestamp: t1 + 1000,
        author: { bot: false, username: "bob", id: "user-2" },
      });
      const msg3 = makeMsg({
        content: "<@bot-123> follow-up three",
        id: "msg-3",
        createdTimestamp: t1 + 2000,
        author: { bot: false, username: "carol", id: "user-3" },
      });
      await (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg2);
      await (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg3);

      // Release the agent — turn_end fires onToolComplete which should persist msg2, msg3
      resolveAgent!();
      await inFlight;

      const calls = (localSessionStore.addMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const userCalls = calls.filter((c) => (c[1] as { role: string }).role === "user");
      // Expect: msg1 (initial), msg2, msg3
      expect(userCalls.length).toBeGreaterThanOrEqual(3);

      const buffered = userCalls.filter((c) => (c[1] as { metadata?: { buffered?: boolean } }).metadata?.buffered);
      expect(buffered).toHaveLength(2);

      const senders = buffered.map((c) => (c[1] as { metadata: { sender: string } }).metadata.sender).sort();
      expect(senders).toEqual(["bob", "carol"]);

      const timestamps = buffered.map((c) => (c[1] as { timestamp: number }).timestamp).sort();
      expect(timestamps).toEqual([t1 + 1000, t1 + 2000]);
    });

    it("clears active session and pending buffer after agent completes", async () => {
      const localAgentManager = createMockAgentManager();
      const localSessionStore = createMockSessionStore();

      // Agent that completes normally
      const completingAgent = createMockAgentInstance([
        { type: "text_delta", text: "Done!" },
        { type: "agent_end", messages: [] },
      ]);
      localAgentManager.get = vi.fn().mockReturnValue(completingAgent);

      const localTransport = new DiscordTransport({
        token: "test-token",
        agentManager: localAgentManager,
        sessionStore: localSessionStore,
        defaultAgentId: "default",
      });

      await localTransport.start();

      const msg = makeMsg({ content: "<@bot-123> hello", id: "msg-1" });
      await (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg);

      // After completion, sending another message should trigger a new prompt (not buffered)
      const msg2 = makeMsg({ content: "<@bot-123> hello again", id: "msg-2" });
      await (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg2);

      expect(completingAgent.prompt).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Main-agent /stop and /cancel (issue #364)
  // ---------------------------------------------------------------------------

  describe("main-agent /stop", () => {
    function makeChannel(): MockChannel {
      return {
        sendTyping: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue(undefined) }),
        isThread: vi.fn().mockReturnValue(false),
      };
    }

    function makeMsg(overrides: Partial<MockIncomingMessage> = {}): MockIncomingMessage {
      return {
        author: { bot: false, username: "tester", id: "user-1" },
        content: "<@bot-123> hello",
        createdTimestamp: Date.now(),
        guild: { id: "guild-1" },
        channelId: "channel-1",
        channel: makeChannel(),
        mentions: { has: vi.fn((id: string) => id === "bot-123") },
        thread: undefined,
        id: `msg-${Date.now()}`,
        ...overrides,
      };
    }

    function makeHangingAgent() {
      let resolve!: () => void;
      const wait = new Promise<void>((r) => { resolve = r; });
      const agent = {
        prompt: vi.fn(async function* () {
          yield { type: "text_delta" as const, text: "thinking..." };
          await wait;
          yield { type: "agent_end" as const, messages: [] };
        }),
        abort: vi.fn(),
        steer: vi.fn(),
        followUp: vi.fn(),
      };
      return { agent, release: () => resolve() };
    }

    function makeStatefulSessionStore(sessionId = "session-stop") {
      const store = createMockSessionStore(sessionId);
      let stored: { id: string; agentId: string; lastActiveAt: Date; key?: string } | undefined;
      store.create = vi.fn(async (agentId: string, opts?: { key?: string }) => {
        stored = { id: sessionId, agentId, lastActiveAt: new Date(), key: opts?.key };
        return stored;
      }) as unknown as typeof store.create;
      store.findByKey = vi.fn(async (key: string) => (stored?.key === key ? stored : undefined)) as unknown as typeof store.findByKey;
      return store;
    }

    it("/stop aborts an in-flight main-agent turn and acks with 🛑", async () => {
      const localAgentManager = createMockAgentManager();
      const localSessionStore = makeStatefulSessionStore();
      const { agent, release } = makeHangingAgent();
      localAgentManager.get = vi.fn().mockReturnValue(agent);

      const localTransport = new DiscordTransport({
        token: "test-token",
        agentManager: localAgentManager,
        sessionStore: localSessionStore,
        defaultAgentId: "default",
      });
      await localTransport.start();

      const channel = makeChannel();
      const msg1 = makeMsg({ channel, content: "<@bot-123> long task", id: "msg-1" });
      const inFlight = (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(msg1);
      await new Promise((r) => setTimeout(r, 100));

      const stopChannel = makeChannel();
      const stopMsg = makeMsg({ channel: stopChannel, content: "<@bot-123> /stop", id: "msg-stop" });
      await (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(stopMsg);

      expect(agent.abort).toHaveBeenCalledTimes(1);
      expect(stopChannel.send).toHaveBeenCalledWith("🛑 Stopped.");

      release();
      await inFlight;
    });

    it("/cancel also aborts the in-flight turn", async () => {
      const localAgentManager = createMockAgentManager();
      const localSessionStore = makeStatefulSessionStore();
      const { agent, release } = makeHangingAgent();
      localAgentManager.get = vi.fn().mockReturnValue(agent);

      const localTransport = new DiscordTransport({
        token: "test-token",
        agentManager: localAgentManager,
        sessionStore: localSessionStore,
        defaultAgentId: "default",
      });
      await localTransport.start();

      const inFlight = (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(
        makeMsg({ content: "<@bot-123> long task", id: "msg-1" }),
      );
      await new Promise((r) => setTimeout(r, 100));

      const stopChannel = makeChannel();
      await (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(
        makeMsg({ channel: stopChannel, content: "<@bot-123> /cancel", id: "msg-stop" }),
      );

      expect(agent.abort).toHaveBeenCalledTimes(1);
      release();
      await inFlight;
    });

    it("/stop with no active turn does not abort and does not dispatch to model", async () => {
      const localAgentManager = createMockAgentManager();
      const localSessionStore = createMockSessionStore();
      const agent = {
        prompt: vi.fn(),
        abort: vi.fn(),
        steer: vi.fn(),
        followUp: vi.fn(),
      };
      localAgentManager.get = vi.fn().mockReturnValue(agent);

      const localTransport = new DiscordTransport({
        token: "test-token",
        agentManager: localAgentManager,
        sessionStore: localSessionStore,
        defaultAgentId: "default",
      });
      await localTransport.start();

      const channel = makeChannel();
      await (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(
        makeMsg({ channel, content: "/stop", id: "msg-stop" }),
      );

      expect(agent.abort).not.toHaveBeenCalled();
      expect(agent.prompt).not.toHaveBeenCalled();
      expect(channel.send).not.toHaveBeenCalled();
    });

    it("normal messages during an in-flight turn do NOT abort (steer-at-turn_end preserved)", async () => {
      const localAgentManager = createMockAgentManager();
      const localSessionStore = createMockSessionStore();
      const { agent, release } = makeHangingAgent();
      localAgentManager.get = vi.fn().mockReturnValue(agent);

      const localTransport = new DiscordTransport({
        token: "test-token",
        agentManager: localAgentManager,
        sessionStore: localSessionStore,
        defaultAgentId: "default",
      });
      await localTransport.start();

      const inFlight = (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(
        makeMsg({ content: "<@bot-123> long task", id: "msg-1" }),
      );
      await new Promise((r) => setTimeout(r, 100));

      // Plain user message — should be buffered, not abort
      await (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(
        makeMsg({ content: "<@bot-123> are you done?", id: "msg-2" }),
      );

      expect(agent.abort).not.toHaveBeenCalled();
      expect(agent.prompt).toHaveBeenCalledTimes(1);

      release();
      await inFlight;
    });
    it("/stop in a group channel without @mention is ignored (multi-bot safety)", async () => {
      const localAgentManager = createMockAgentManager();
      const localSessionStore = makeStatefulSessionStore();
      const { agent, release } = makeHangingAgent();
      localAgentManager.get = vi.fn().mockReturnValue(agent);

      const localTransport = new DiscordTransport({
        token: "test-token",
        agentManager: localAgentManager,
        sessionStore: localSessionStore,
        defaultAgentId: "default",
      });
      await localTransport.start();

      const inFlight = (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(
        makeMsg({ content: "<@bot-123> long task", id: "msg-1" }),
      );
      await new Promise((r) => setTimeout(r, 100));

      // Bare /stop in guild, NOT mentioning this bot — must be ignored
      await (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(
        makeMsg({ content: "/stop", id: "msg-stop", mentions: { has: vi.fn(() => false) } }),
      );

      expect(agent.abort).not.toHaveBeenCalled();

      release();
      await inFlight;
    });

    it("/stop in a DM (no guild) works without @mention", async () => {
      const localAgentManager = createMockAgentManager();
      const localSessionStore = makeStatefulSessionStore();
      const { agent, release } = makeHangingAgent();
      localAgentManager.get = vi.fn().mockReturnValue(agent);

      const localTransport = new DiscordTransport({
        token: "test-token",
        agentManager: localAgentManager,
        sessionStore: localSessionStore,
        defaultAgentId: "default",
      });
      await localTransport.start();

      const inFlight = (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(
        makeMsg({ content: "long task", id: "msg-1", guild: undefined, mentions: { has: vi.fn(() => false) } }),
      );
      await new Promise((r) => setTimeout(r, 100));

      const stopChannel = makeChannel();
      await (localTransport as unknown as { handleMessage: (m: MockIncomingMessage) => Promise<void> }).handleMessage(
        makeMsg({ channel: stopChannel, content: "/stop", id: "msg-stop", guild: undefined, mentions: { has: vi.fn(() => false) } }),
      );

      expect(agent.abort).toHaveBeenCalledTimes(1);
      expect(stopChannel.send).toHaveBeenCalledWith("🛑 Stopped.");

      release();
      await inFlight;
    });
  });
});
