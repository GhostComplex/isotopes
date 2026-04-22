// src/transports/feishu.test.ts — Unit tests for FeishuTransport

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FeishuTransport,
  extractTextFromFeishuMessage,
  buildFeishuSessionKey,
  stripFeishuMentions,
  isBotMentioned,
  shouldRespondToGroupMessage,
  resolveAgentId,
  type FeishuMessageEvent,
} from "./feishu.js";
import type { AgentManager, SessionStore, AgentInstance, AgentEvent, ChannelsConfig, Binding } from "../core/types.js";
import {
  createMockAgentManager,
  createMockAgentInstance,
  createMockSessionStore,
} from "../core/test-helpers.js";

// Suppress console output during tests
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "debug").mockImplementation(() => {});

// ---------------------------------------------------------------------------
// Mock @larksuiteoapi/node-sdk
// ---------------------------------------------------------------------------

const mockWsStart = vi.fn().mockResolvedValue(undefined);
const mockWsClose = vi.fn();
const mockMessageCreate = vi.fn().mockResolvedValue({ code: 0 });

// Capture the event handler registered via EventDispatcher.register
let capturedEventHandler: ((data: FeishuMessageEvent) => Promise<void>) | null = null;

vi.mock("@larksuiteoapi/node-sdk", () => {
  return {
    Client: vi.fn(() => ({
      im: {
        message: {
          create: mockMessageCreate,
        },
      },
    })),
    EventDispatcher: vi.fn(() => ({
      register: vi.fn((handles: Record<string, (data: FeishuMessageEvent) => Promise<void>>) => {
        capturedEventHandler = handles["im.message.receive_v1"] ?? null;
        return { register: vi.fn() };
      }),
    })),
    WSClient: vi.fn(() => ({
      start: mockWsStart,
      close: mockWsClose,
    })),
  };
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createDMEvent(overrides: Partial<FeishuMessageEvent> = {}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: "ou_user123",
        user_id: "user123",
      },
      sender_type: "user",
      ...overrides.sender,
    },
    message: {
      message_id: "msg_123",
      create_time: "1700000000000",
      chat_id: "oc_chat123",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "Hello bot" }),
      ...overrides.message,
    },
  };
}

function createGroupEvent(
  overrides: {
    sender?: Partial<FeishuMessageEvent["sender"]>;
    message?: Partial<FeishuMessageEvent["message"]>;
  } = {},
): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: "ou_user123",
        user_id: "user123",
      },
      sender_type: "user",
      ...overrides.sender,
    },
    message: {
      message_id: "msg_group_456",
      create_time: "1700000000000",
      chat_id: "oc_group789",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "@_user_1 Hello bot" }),
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot_open_id", user_id: "bot_uid" },
          name: "TestBot",
        },
      ],
      ...overrides.message,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractTextFromFeishuMessage", () => {
  it("extracts text from a valid text message", () => {
    const content = JSON.stringify({ text: "Hello world" });
    expect(extractTextFromFeishuMessage(content, "text")).toBe("Hello world");
  });

  it("returns null for non-text message types", () => {
    expect(extractTextFromFeishuMessage("{}", "image")).toBeNull();
    expect(extractTextFromFeishuMessage("{}", "post")).toBeNull();
    expect(extractTextFromFeishuMessage("{}", "interactive")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(extractTextFromFeishuMessage("not json", "text")).toBeNull();
  });

  it("returns null when text field is missing", () => {
    const content = JSON.stringify({ other: "field" });
    expect(extractTextFromFeishuMessage(content, "text")).toBeNull();
  });

  it("handles empty text", () => {
    const content = JSON.stringify({ text: "" });
    expect(extractTextFromFeishuMessage(content, "text")).toBe("");
  });

  it("handles text with special characters", () => {
    const content = JSON.stringify({ text: 'Hello "world" & <friends>' });
    expect(extractTextFromFeishuMessage(content, "text")).toBe('Hello "world" & <friends>');
  });

  it("handles text with newlines", () => {
    const content = JSON.stringify({ text: "line1\nline2\nline3" });
    expect(extractTextFromFeishuMessage(content, "text")).toBe("line1\nline2\nline3");
  });
});

describe("stripFeishuMentions", () => {
  it("strips a single @mention", () => {
    expect(stripFeishuMentions("@_user_1 hello")).toBe("hello");
  });

  it("strips multiple @mentions", () => {
    expect(stripFeishuMentions("@_user_1 @_user_2 hello")).toBe("hello");
  });

  it("returns original text when no mentions present", () => {
    expect(stripFeishuMentions("hello world")).toBe("hello world");
  });

  it("does not strip non-mention @ patterns", () => {
    expect(stripFeishuMentions("email@example.com hello")).toBe("email@example.com hello");
  });

  it("handles mention in the middle of text", () => {
    expect(stripFeishuMentions("hey @_user_1 what's up")).toBe("hey what's up");
  });

  it("collapses extra whitespace after stripping", () => {
    expect(stripFeishuMentions("  @_user_1   hello   world  ")).toBe("hello world");
  });

  it("returns empty string when text is only a mention", () => {
    expect(stripFeishuMentions("@_user_1")).toBe("");
  });

  it("handles high-numbered mention keys", () => {
    expect(stripFeishuMentions("@_user_99 test")).toBe("test");
  });
});

describe("isBotMentioned", () => {
  const botOpenId = "ou_bot_open_id";

  it("returns true when bot is mentioned", () => {
    const mentions = [
      { key: "@_user_1", id: { open_id: botOpenId }, name: "Bot" },
    ];
    expect(isBotMentioned(mentions, botOpenId)).toBe(true);
  });

  it("returns false when bot is not mentioned", () => {
    const mentions = [
      { key: "@_user_1", id: { open_id: "ou_other_user" }, name: "SomeUser" },
    ];
    expect(isBotMentioned(mentions, botOpenId)).toBe(false);
  });

  it("returns false for empty mentions array", () => {
    expect(isBotMentioned([], botOpenId)).toBe(false);
  });

  it("returns false for undefined mentions", () => {
    expect(isBotMentioned(undefined, botOpenId)).toBe(false);
  });

  it("returns true when bot is among multiple mentions", () => {
    const mentions = [
      { key: "@_user_1", id: { open_id: "ou_other" }, name: "User1" },
      { key: "@_user_2", id: { open_id: botOpenId }, name: "Bot" },
    ];
    expect(isBotMentioned(mentions, botOpenId)).toBe(true);
  });
});

describe("buildFeishuSessionKey", () => {
  it("builds correct session key for DM (default)", () => {
    expect(buildFeishuSessionKey("app123", "user456", "agent1")).toBe(
      "feishu:app123:dm:user456:agent1",
    );
  });

  it("builds correct session key for DM (explicit)", () => {
    expect(buildFeishuSessionKey("app123", "user456", "agent1", "p2p")).toBe(
      "feishu:app123:dm:user456:agent1",
    );
  });

  it("builds correct session key for group", () => {
    expect(buildFeishuSessionKey("app123", "oc_group789", "agent1", "group")).toBe(
      "feishu:app123:group:oc_group789:agent1",
    );
  });

  it("uses different keys for different users", () => {
    const key1 = buildFeishuSessionKey("app1", "userA", "agent1");
    const key2 = buildFeishuSessionKey("app1", "userB", "agent1");
    expect(key1).not.toBe(key2);
  });

  it("uses different keys for different agents", () => {
    const key1 = buildFeishuSessionKey("app1", "user1", "agentA");
    const key2 = buildFeishuSessionKey("app1", "user1", "agentB");
    expect(key1).not.toBe(key2);
  });

  it("uses different keys for different bots", () => {
    const key1 = buildFeishuSessionKey("appA", "user1", "agent1");
    const key2 = buildFeishuSessionKey("appB", "user1", "agent1");
    expect(key1).not.toBe(key2);
  });

  it("uses different keys for DM vs group with same scope ID", () => {
    const dmKey = buildFeishuSessionKey("app1", "scope1", "agent1", "p2p");
    const groupKey = buildFeishuSessionKey("app1", "scope1", "agent1", "group");
    expect(dmKey).not.toBe(groupKey);
    expect(dmKey).toContain(":dm:");
    expect(groupKey).toContain(":group:");
  });
});

describe("shouldRespondToGroupMessage", () => {
  const chatId = "oc_group789";

  it("returns true when mentioned and no channels config", () => {
    expect(shouldRespondToGroupMessage(chatId, true)).toBe(true);
  });

  it("returns false when not mentioned and no channels config", () => {
    expect(shouldRespondToGroupMessage(chatId, false)).toBe(false);
  });

  it("returns true when mentioned and channels config is undefined", () => {
    expect(shouldRespondToGroupMessage(chatId, true, undefined)).toBe(true);
  });

  it("returns false when not mentioned and feishu section missing", () => {
    const channels: ChannelsConfig = {};
    expect(shouldRespondToGroupMessage(chatId, false, channels)).toBe(false);
  });

  it("returns false when not mentioned and feishu.groups missing", () => {
    const channels: ChannelsConfig = { feishu: { enabled: true } };
    expect(shouldRespondToGroupMessage(chatId, false, channels)).toBe(false);
  });

  it("returns false when not mentioned and group not listed in config", () => {
    const channels: ChannelsConfig = {
      feishu: { groups: { "oc_other_group": { requireMention: false } } },
    };
    expect(shouldRespondToGroupMessage(chatId, false, channels)).toBe(false);
  });

  it("returns true when mentioned and group not listed in config", () => {
    const channels: ChannelsConfig = {
      feishu: { groups: { "oc_other_group": { requireMention: false } } },
    };
    expect(shouldRespondToGroupMessage(chatId, true, channels)).toBe(true);
  });

  it("returns true when not mentioned and requireMention is false", () => {
    const channels: ChannelsConfig = {
      feishu: { groups: { [chatId]: { requireMention: false } } },
    };
    expect(shouldRespondToGroupMessage(chatId, false, channels)).toBe(true);
  });

  it("returns true when mentioned and requireMention is false", () => {
    const channels: ChannelsConfig = {
      feishu: { groups: { [chatId]: { requireMention: false } } },
    };
    expect(shouldRespondToGroupMessage(chatId, true, channels)).toBe(true);
  });

  it("returns false when not mentioned and requireMention is true", () => {
    const channels: ChannelsConfig = {
      feishu: { groups: { [chatId]: { requireMention: true } } },
    };
    expect(shouldRespondToGroupMessage(chatId, false, channels)).toBe(false);
  });

  it("returns true when mentioned and requireMention is true", () => {
    const channels: ChannelsConfig = {
      feishu: { groups: { [chatId]: { requireMention: true } } },
    };
    expect(shouldRespondToGroupMessage(chatId, true, channels)).toBe(true);
  });

  it("defaults to requireMention=true when group config has no requireMention field", () => {
    const channels: ChannelsConfig = {
      feishu: { groups: { [chatId]: {} } },
    };
    expect(shouldRespondToGroupMessage(chatId, false, channels)).toBe(false);
    expect(shouldRespondToGroupMessage(chatId, true, channels)).toBe(true);
  });

  it("handles different groups independently", () => {
    const channels: ChannelsConfig = {
      feishu: {
        groups: {
          "oc_group_a": { requireMention: false },
          "oc_group_b": { requireMention: true },
        },
      },
    };
    // Group A: no mention required
    expect(shouldRespondToGroupMessage("oc_group_a", false, channels)).toBe(true);
    // Group B: mention required
    expect(shouldRespondToGroupMessage("oc_group_b", false, channels)).toBe(false);
  });

  it("ignores extra arguments (Feishu uses flat group config)", () => {
    const channels: ChannelsConfig = {
      feishu: { groups: { [chatId]: { requireMention: false } } },
    };
    expect(shouldRespondToGroupMessage(chatId, false, channels)).toBe(true);
  });
});

describe("FeishuTransport", () => {
  let transport: FeishuTransport;
  let agentManager: AgentManager;
  let sessionStore: SessionStore;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedEventHandler = null;
    agentManager = createMockAgentManager(
      createMockAgentInstance([
        { type: "text_delta", text: "Hello " },
        { type: "text_delta", text: "from Feishu!" },
        { type: "agent_end", messages: [] },
      ]),
    );
    sessionStore = createMockSessionStore("session-feishu-123");
    transport = new FeishuTransport({
      appId: "test-app-id",
      appSecret: "test-app-secret",
      agentManager,
      sessionStore,
      defaultAgentId: "default",
      botOpenId: "ou_bot_open_id",
    });
  });

  describe("start", () => {
    it("starts the WebSocket client", async () => {
      await transport.start();
      expect(mockWsStart).toHaveBeenCalledWith({
        eventDispatcher: expect.anything(),
      });
    });

    it("does not start twice", async () => {
      await transport.start();
      await transport.start();
      expect(mockWsStart).toHaveBeenCalledTimes(1);
    });
  });

  describe("stop", () => {
    it("closes the WebSocket client", async () => {
      await transport.start();
      await transport.stop();
      expect(mockWsClose).toHaveBeenCalled();
    });

    it("is a no-op when not started", async () => {
      await transport.stop();
      expect(mockWsClose).not.toHaveBeenCalled();
    });
  });

  describe("message handling", () => {
    it("registers an event handler for im.message.receive_v1", () => {
      // Constructor should have registered the handler
      expect(capturedEventHandler).toBeInstanceOf(Function);
    });

    it("processes a valid DM text message", async () => {
      expect(capturedEventHandler).not.toBeNull();
      const event = createDMEvent();
      await capturedEventHandler!(event);

      // Should have created a session
      expect(sessionStore.findByKey).toHaveBeenCalledWith(
        "feishu:test-app-id:dm:ou_user123:default",
      );
      expect(sessionStore.create).toHaveBeenCalledWith("default", {
        key: "feishu:test-app-id:dm:ou_user123:default",
        transport: "feishu",
      });

      // Should have added user message
      expect(sessionStore.addMessage).toHaveBeenCalledWith(
        "session-feishu-123",
        expect.objectContaining({
          role: "user",
          content: "Hello bot",
        }),
      );

      // Should have called agent
      const agent = agentManager.get("default")!;
      expect(agent.prompt).toHaveBeenCalled();

      // Should have sent a reply
      expect(mockMessageCreate).toHaveBeenCalledWith({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: "oc_chat123",
          content: JSON.stringify({ text: "Hello from Feishu!" }),
          msg_type: "text",
        },
      });

      // Should have stored assistant message
      expect(sessionStore.addMessage).toHaveBeenCalledWith(
        "session-feishu-123",
        expect.objectContaining({
          role: "assistant",
        }),
      );
    });

    it("ignores non-user messages (bot self-messages)", async () => {
      const event = createDMEvent({
        sender: {
          sender_type: "app",
          sender_id: { open_id: "ou_bot" },
        },
      });

      await capturedEventHandler!(event);
      expect(sessionStore.findByKey).not.toHaveBeenCalled();
      expect(agentManager.get).not.toHaveBeenCalled();
    });

    it("processes group messages when bot is mentioned", async () => {
      expect(capturedEventHandler).not.toBeNull();
      const event = createGroupEvent();
      await capturedEventHandler!(event);

      // Should use group session key (scoped by chatId, not userId)
      expect(sessionStore.findByKey).toHaveBeenCalledWith(
        "feishu:test-app-id:group:oc_group789:default",
      );
      expect(sessionStore.create).toHaveBeenCalledWith("default", {
        key: "feishu:test-app-id:group:oc_group789:default",
        transport: "feishu",
      });

      // Should have added user message with mentions stripped
      expect(sessionStore.addMessage).toHaveBeenCalledWith(
        "session-feishu-123",
        expect.objectContaining({
          role: "user",
          content: "Hello bot",
        }),
      );

      // Should have sent a reply
      expect(mockMessageCreate).toHaveBeenCalled();
    });

    it("ignores group messages when bot is NOT mentioned", async () => {
      const event = createGroupEvent({
        message: {
          message_id: "msg_group_456",
          create_time: "1700000000000",
          chat_id: "oc_group789",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "Hello everyone" }),
          mentions: [
            {
              key: "@_user_1",
              id: { open_id: "ou_other_user" },
              name: "OtherUser",
            },
          ],
        },
      });

      await capturedEventHandler!(event);
      expect(sessionStore.findByKey).not.toHaveBeenCalled();
    });

    it("ignores group messages when no mentions at all", async () => {
      const event = createGroupEvent({
        message: {
          message_id: "msg_group_456",
          create_time: "1700000000000",
          chat_id: "oc_group789",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "Hello everyone" }),
          mentions: undefined,
        },
      });

      await capturedEventHandler!(event);
      expect(sessionStore.findByKey).not.toHaveBeenCalled();
    });

    it("ignores group messages when botOpenId is not configured", async () => {
      // Create transport without botOpenId
      capturedEventHandler = null;
      // Side-effect: constructor registers capturedEventHandler
      new FeishuTransport({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        // no botOpenId
      });
      // Constructor re-registered the handler
      expect(capturedEventHandler).not.toBeNull();

      const event = createGroupEvent();
      await capturedEventHandler!(event);
      expect(sessionStore.findByKey).not.toHaveBeenCalled();
    });

    it("strips mentions from group message text before passing to agent", async () => {
      const event = createGroupEvent({
        message: {
          message_id: "msg_group_456",
          create_time: "1700000000000",
          chat_id: "oc_group789",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 @_user_2 tell me a joke" }),
          mentions: [
            { key: "@_user_1", id: { open_id: "ou_bot_open_id" }, name: "Bot" },
            { key: "@_user_2", id: { open_id: "ou_other" }, name: "Other" },
          ],
        },
      });

      await capturedEventHandler!(event);

      expect(sessionStore.addMessage).toHaveBeenCalledWith(
        "session-feishu-123",
        expect.objectContaining({
          role: "user",
          content: "tell me a joke",
        }),
      );
    });

    it("does not strip mentions from DM messages", async () => {
      // DMs don't have @mention tokens, but if they did they should be kept
      const event = createDMEvent({
        message: {
          message_id: "msg_123",
          create_time: "1700000000000",
          chat_id: "oc_chat123",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "email@_user_1 test" }),
        },
      });

      await capturedEventHandler!(event);

      expect(sessionStore.addMessage).toHaveBeenCalledWith(
        "session-feishu-123",
        expect.objectContaining({
          role: "user",
          content: "email@_user_1 test",
        }),
      );
    });

    it("ignores non-text message types", async () => {
      const event = createDMEvent({
        message: {
          message_id: "msg_123",
          create_time: "1700000000000",
          chat_id: "oc_chat123",
          chat_type: "p2p",
          message_type: "image",
          content: "{}",
        },
      });

      await capturedEventHandler!(event);
      expect(sessionStore.findByKey).not.toHaveBeenCalled();
    });

    it("ignores empty text messages", async () => {
      const event = createDMEvent({
        message: {
          message_id: "msg_123",
          create_time: "1700000000000",
          chat_id: "oc_chat123",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "   " }),
        },
      });

      await capturedEventHandler!(event);
      expect(sessionStore.findByKey).not.toHaveBeenCalled();
    });

    it("uses existing session when found", async () => {
      sessionStore.findByKey = vi.fn().mockResolvedValue({
        id: "existing-session",
        agentId: "default",
        lastActiveAt: new Date(),
      });

      const event = createDMEvent();
      await capturedEventHandler!(event);

      expect(sessionStore.create).not.toHaveBeenCalled();
      expect(sessionStore.addMessage).toHaveBeenCalledWith(
        "existing-session",
        expect.objectContaining({ role: "user" }),
      );
    });

    it("does nothing when agent is not found", async () => {
      agentManager.get = vi.fn(() => undefined);

      const event = createDMEvent();
      await capturedEventHandler!(event);

      expect(sessionStore.findByKey).not.toHaveBeenCalled();
      expect(mockMessageCreate).not.toHaveBeenCalled();
    });

    it("falls back to user_id when open_id is missing", async () => {
      const event = createDMEvent({
        sender: {
          sender_id: {
            user_id: "uid_fallback",
          },
          sender_type: "user",
        },
      });

      await capturedEventHandler!(event);

      expect(sessionStore.findByKey).toHaveBeenCalledWith(
        "feishu:test-app-id:dm:uid_fallback:default",
      );
    });

    it("uses 'unknown' when no sender IDs are available", async () => {
      const event = createDMEvent({
        sender: {
          sender_id: {},
          sender_type: "user",
        },
      });

      await capturedEventHandler!(event);

      expect(sessionStore.findByKey).toHaveBeenCalledWith(
        "feishu:test-app-id:dm:unknown:default",
      );
    });

    it("sends error message when agent throws", async () => {
      // Create an async iterable that throws on first iteration
      const throwingIterable: AsyncIterable<AgentEvent> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw new Error("Agent crashed");
            },
          };
        },
      };
      const errorAgent: AgentInstance = {
        prompt: vi.fn(() => throwingIterable),
        abort: vi.fn(),
        steer: vi.fn(),
        followUp: vi.fn(),
      };
      agentManager.get = vi.fn(() => errorAgent);

      const event = createDMEvent();
      await capturedEventHandler!(event);

      expect(mockMessageCreate).toHaveBeenCalledWith({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: "oc_chat123",
          content: JSON.stringify({ text: "An error occurred while processing your request." }),
          msg_type: "text",
        },
      });
    });

    it("handles agent_end with error stopReason", async () => {
      const errorAgent = createMockAgentInstance([
        {
          type: "agent_end",
          messages: [],
          stopReason: "error",
          errorMessage: "API key invalid",
        },
      ]);
      agentManager.get = vi.fn(() => errorAgent);

      const event = createDMEvent();
      await capturedEventHandler!(event);

      expect(mockMessageCreate).toHaveBeenCalledWith({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: "oc_chat123",
          content: JSON.stringify({ text: "Error: API key invalid" }),
          msg_type: "text",
        },
      });
    });

    it("defaults to 'default' agent when no defaultAgentId configured", () => {
      const transportNoDefault = new FeishuTransport({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        agentManager,
        sessionStore,
      });

      // Verify the transport was created successfully (no throw)
      expect(transportNoDefault).toBeInstanceOf(FeishuTransport);
    });

    it("passes full conversation history to agent.prompt", async () => {
      const previousMessages = [
        { role: "user" as const, content: "Hi", timestamp: 1000 },
        { role: "assistant" as const, content: "Hello!", timestamp: 2000 },
      ];

      sessionStore.findByKey = vi.fn().mockResolvedValue({
        id: "existing-session",
        agentId: "default",
        lastActiveAt: new Date(),
      });

      // getMessages returns previous history PLUS the new message we just added
      sessionStore.getMessages = vi.fn().mockResolvedValue([
        ...previousMessages,
        { role: "user" as const, content: "Hello bot", timestamp: 1700000000000 },
      ]);

      const event = createDMEvent();
      await capturedEventHandler!(event);

      const agent = agentManager.get("default")!;
      expect(agent.prompt).toHaveBeenCalledWith([
        ...previousMessages,
        expect.objectContaining({ role: "user", content: "Hello bot" }),
      ]);
    });
  });

  describe("requireMention configuration", () => {
    it("responds to group messages without mention when requireMention is false", async () => {
      capturedEventHandler = null;
      new FeishuTransport({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        botOpenId: "ou_bot_open_id",
        channels: {
          feishu: {
            groups: {
              "oc_group789": { requireMention: false },
            },
          },
        },
      });
      expect(capturedEventHandler).not.toBeNull();

      // Group message WITHOUT bot mention
      const event = createGroupEvent({
        message: {
          message_id: "msg_group_456",
          create_time: "1700000000000",
          chat_id: "oc_group789",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "Hello everyone" }),
          mentions: undefined,
        },
      });

      await capturedEventHandler!(event);

      // Should have processed the message (created session)
      expect(sessionStore.findByKey).toHaveBeenCalledWith(
        "feishu:test-app-id:group:oc_group789:default",
      );
      expect(mockMessageCreate).toHaveBeenCalled();
    });

    it("ignores group messages without mention when requireMention is true", async () => {
      capturedEventHandler = null;
      new FeishuTransport({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        botOpenId: "ou_bot_open_id",
        channels: {
          feishu: {
            groups: {
              "oc_group789": { requireMention: true },
            },
          },
        },
      });
      expect(capturedEventHandler).not.toBeNull();

      const event = createGroupEvent({
        message: {
          message_id: "msg_group_456",
          create_time: "1700000000000",
          chat_id: "oc_group789",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "Hello everyone" }),
          mentions: undefined,
        },
      });

      await capturedEventHandler!(event);
      expect(sessionStore.findByKey).not.toHaveBeenCalled();
    });

    it("responds to mentioned group messages regardless of requireMention config", async () => {
      capturedEventHandler = null;
      new FeishuTransport({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        botOpenId: "ou_bot_open_id",
        channels: {
          feishu: {
            groups: {
              "oc_group789": { requireMention: true },
            },
          },
        },
      });
      expect(capturedEventHandler).not.toBeNull();

      // Bot IS mentioned
      const event = createGroupEvent();
      await capturedEventHandler!(event);

      expect(sessionStore.findByKey).toHaveBeenCalled();
      expect(mockMessageCreate).toHaveBeenCalled();
    });

    it("defaults to require mention when no channels config provided", async () => {
      // Default transport (no channels config) — already set up in beforeEach
      const event = createGroupEvent({
        message: {
          message_id: "msg_group_456",
          create_time: "1700000000000",
          chat_id: "oc_group789",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "Hello everyone" }),
          mentions: undefined,
        },
      });

      await capturedEventHandler!(event);
      // Without mention and without config, should be ignored
      expect(sessionStore.findByKey).not.toHaveBeenCalled();
    });

    it("defaults to require mention for unconfigured groups", async () => {
      capturedEventHandler = null;
      new FeishuTransport({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        botOpenId: "ou_bot_open_id",
        channels: {
          feishu: {
            groups: {
              "oc_other_group": { requireMention: false },
            },
          },
        },
      });
      expect(capturedEventHandler).not.toBeNull();

      // Send to oc_group789 which is NOT in the config
      const event = createGroupEvent({
        message: {
          message_id: "msg_group_456",
          create_time: "1700000000000",
          chat_id: "oc_group789",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "Hello everyone" }),
          mentions: undefined,
        },
      });

      await capturedEventHandler!(event);
      // Unconfigured group defaults to require mention, so without mention it's ignored
      expect(sessionStore.findByKey).not.toHaveBeenCalled();
    });

    it("still processes DMs normally with channels config", async () => {
      capturedEventHandler = null;
      new FeishuTransport({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        botOpenId: "ou_bot_open_id",
        channels: {
          feishu: {
            groups: {
              "oc_group789": { requireMention: true },
            },
          },
        },
      });
      expect(capturedEventHandler).not.toBeNull();

      const event = createDMEvent();
      await capturedEventHandler!(event);

      // DMs should always work
      expect(sessionStore.findByKey).toHaveBeenCalledWith(
        "feishu:test-app-id:dm:ou_user123:default",
      );
      expect(mockMessageCreate).toHaveBeenCalled();
    });
  });

  describe("bindings integration", () => {
    it("routes to agent specified by channel-level binding", async () => {
      capturedEventHandler = null;

      const bindings: Binding[] = [
        { agentId: "major", match: { channel: "feishu", accountId: "bot-account" } },
      ];

      new FeishuTransport({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        botOpenId: "ou_bot_open_id",
        accountId: "bot-account",
        bindings,
      });
      expect(capturedEventHandler).not.toBeNull();

      const event = createDMEvent();
      await capturedEventHandler!(event);

      // Should resolve to "major" agent via binding
      expect(agentManager.get).toHaveBeenCalledWith("major");
      expect(sessionStore.findByKey).toHaveBeenCalledWith(
        "feishu:test-app-id:dm:ou_user123:major",
      );
    });

    it("routes to agent specified by group-specific binding (higher priority)", async () => {
      capturedEventHandler = null;

      const bindings: Binding[] = [
        { agentId: "general-agent", match: { channel: "feishu", accountId: "bot-account" } },
        { agentId: "group-agent", match: { channel: "feishu", accountId: "bot-account", peer: { kind: "group", id: "oc_group789" } } },
      ];

      new FeishuTransport({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        botOpenId: "ou_bot_open_id",
        accountId: "bot-account",
        bindings,
      });
      expect(capturedEventHandler).not.toBeNull();

      // Send a group message (with bot mentioned)
      const event = createGroupEvent();
      await capturedEventHandler!(event);

      // Should resolve to "group-agent" (more specific binding wins)
      expect(agentManager.get).toHaveBeenCalledWith("group-agent");
      expect(sessionStore.findByKey).toHaveBeenCalledWith(
        "feishu:test-app-id:group:oc_group789:group-agent",
      );
    });

    it("routes to agent specified by DM-specific binding", async () => {
      capturedEventHandler = null;

      const bindings: Binding[] = [
        { agentId: "dm-agent", match: { channel: "feishu", accountId: "bot-account", peer: { kind: "dm", id: "ou_user123" } } },
      ];

      new FeishuTransport({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        botOpenId: "ou_bot_open_id",
        accountId: "bot-account",
        bindings,
      });
      expect(capturedEventHandler).not.toBeNull();

      const event = createDMEvent();
      await capturedEventHandler!(event);

      // Should resolve to "dm-agent" via DM-specific binding
      expect(agentManager.get).toHaveBeenCalledWith("dm-agent");
      expect(sessionStore.findByKey).toHaveBeenCalledWith(
        "feishu:test-app-id:dm:ou_user123:dm-agent",
      );
    });

    it("falls back to agentBindings when no binding matches", async () => {
      capturedEventHandler = null;

      // Bindings for discord only (won't match feishu)
      const bindings: Binding[] = [
        { agentId: "discord-agent", match: { channel: "discord", accountId: "bot-account" } },
      ];

      new FeishuTransport({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        botOpenId: "ou_bot_open_id",
        accountId: "bot-account",
        bindings,
        agentBindings: { "bot-account": "legacy-agent" },
      });
      expect(capturedEventHandler).not.toBeNull();

      const event = createDMEvent();
      await capturedEventHandler!(event);

      // Should fall back to agentBindings
      expect(agentManager.get).toHaveBeenCalledWith("legacy-agent");
      expect(sessionStore.findByKey).toHaveBeenCalledWith(
        "feishu:test-app-id:dm:ou_user123:legacy-agent",
      );
    });

    it("falls back to defaultAgentId when nothing matches", async () => {
      capturedEventHandler = null;

      // Empty bindings, no agentBindings
      new FeishuTransport({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        agentManager,
        sessionStore,
        defaultAgentId: "fallback-agent",
        botOpenId: "ou_bot_open_id",
        accountId: "bot-account",
        bindings: [],
      });
      expect(capturedEventHandler).not.toBeNull();

      const event = createDMEvent();
      await capturedEventHandler!(event);

      // Should fall back to defaultAgentId
      expect(agentManager.get).toHaveBeenCalledWith("fallback-agent");
      expect(sessionStore.findByKey).toHaveBeenCalledWith(
        "feishu:test-app-id:dm:ou_user123:fallback-agent",
      );
    });

    it("falls back to 'default' when no bindings, agentBindings, or defaultAgentId", async () => {
      capturedEventHandler = null;

      new FeishuTransport({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        agentManager,
        sessionStore,
        botOpenId: "ou_bot_open_id",
        // No defaultAgentId, no bindings, no agentBindings
      });
      expect(capturedEventHandler).not.toBeNull();

      const event = createDMEvent();
      await capturedEventHandler!(event);

      // Should fall back to hardcoded "default"
      expect(agentManager.get).toHaveBeenCalledWith("default");
    });

    it("uses channel-level binding for DM when group-specific binding doesn't match", async () => {
      capturedEventHandler = null;

      const bindings: Binding[] = [
        { agentId: "channel-agent", match: { channel: "feishu", accountId: "bot-account" } },
        { agentId: "group-agent", match: { channel: "feishu", accountId: "bot-account", peer: { kind: "group", id: "oc_other_group" } } },
      ];

      new FeishuTransport({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        botOpenId: "ou_bot_open_id",
        accountId: "bot-account",
        bindings,
      });
      expect(capturedEventHandler).not.toBeNull();

      // Send a DM — group-specific binding won't match, channel-level will
      const event = createDMEvent();
      await capturedEventHandler!(event);

      expect(agentManager.get).toHaveBeenCalledWith("channel-agent");
    });
  });
});

// ---------------------------------------------------------------------------
// resolveAgentId unit tests
// ---------------------------------------------------------------------------

describe("resolveAgentId", () => {
  it("returns agentId from matching binding", () => {
    const bindings: Binding[] = [
      { agentId: "agent-a", match: { channel: "feishu", accountId: "acct1" } },
    ];
    expect(resolveAgentId(bindings, undefined, "default", "feishu", "acct1", undefined)).toBe("agent-a");
  });

  it("returns most specific binding when multiple match", () => {
    const bindings: Binding[] = [
      { agentId: "channel-agent", match: { channel: "feishu" } },
      { agentId: "account-agent", match: { channel: "feishu", accountId: "acct1" } },
      { agentId: "peer-agent", match: { channel: "feishu", accountId: "acct1", peer: { kind: "group", id: "g1" } } },
    ];
    expect(resolveAgentId(bindings, undefined, "default", "feishu", "acct1", { kind: "group", id: "g1" })).toBe("peer-agent");
  });

  it("falls back to agentBindings when bindings don't match", () => {
    const bindings: Binding[] = [
      { agentId: "discord-agent", match: { channel: "discord" } },
    ];
    const agentBindings = { "bot1": "legacy-agent" };
    expect(resolveAgentId(bindings, agentBindings, "default", "feishu", "bot1", undefined)).toBe("legacy-agent");
  });

  it("falls back to defaultAgentId when nothing else matches", () => {
    expect(resolveAgentId([], undefined, "my-default", "feishu", "acct1", undefined)).toBe("my-default");
  });

  it("returns undefined when nothing matches and no default", () => {
    expect(resolveAgentId([], undefined, undefined, "feishu", "acct1", undefined)).toBeUndefined();
  });

  it("skips bindings when array is undefined", () => {
    const agentBindings = { "acct1": "legacy" };
    expect(resolveAgentId(undefined, agentBindings, "default", "feishu", "acct1", undefined)).toBe("legacy");
  });

  it("skips bindings when array is empty", () => {
    expect(resolveAgentId([], undefined, "fallback", "feishu", "acct1", undefined)).toBe("fallback");
  });

  it("skips agentBindings when accountId is undefined", () => {
    const agentBindings = { "acct1": "legacy" };
    expect(resolveAgentId(undefined, agentBindings, "fallback", "feishu", undefined, undefined)).toBe("fallback");
  });

  it("skips agentBindings when key not found", () => {
    const agentBindings = { "other-acct": "legacy" };
    expect(resolveAgentId(undefined, agentBindings, "fallback", "feishu", "acct1", undefined)).toBe("fallback");
  });

  it("prefers binding over agentBindings even with same accountId", () => {
    const bindings: Binding[] = [
      { agentId: "binding-agent", match: { channel: "feishu", accountId: "acct1" } },
    ];
    const agentBindings = { "acct1": "legacy-agent" };
    expect(resolveAgentId(bindings, agentBindings, "default", "feishu", "acct1", undefined)).toBe("binding-agent");
  });

  it("handles DM peer binding", () => {
    const bindings: Binding[] = [
      { agentId: "dm-agent", match: { channel: "feishu", accountId: "acct1", peer: { kind: "dm", id: "user123" } } },
    ];
    expect(resolveAgentId(bindings, undefined, "default", "feishu", "acct1", { kind: "dm", id: "user123" })).toBe("dm-agent");
  });

  it("does not match wrong peer kind", () => {
    const bindings: Binding[] = [
      { agentId: "group-agent", match: { channel: "feishu", accountId: "acct1", peer: { kind: "group", id: "g1" } } },
    ];
    // Query with dm peer — should not match group binding
    expect(resolveAgentId(bindings, undefined, "default", "feishu", "acct1", { kind: "dm", id: "g1" })).toBe("default");
  });

  it("does not match wrong peer id", () => {
    const bindings: Binding[] = [
      { agentId: "group-agent", match: { channel: "feishu", accountId: "acct1", peer: { kind: "group", id: "g1" } } },
    ];
    expect(resolveAgentId(bindings, undefined, "default", "feishu", "acct1", { kind: "group", id: "g2" })).toBe("default");
  });
});
