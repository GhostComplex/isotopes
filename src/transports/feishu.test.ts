// src/transports/feishu.test.ts — Unit tests for FeishuTransport

import { describe, it, expect, vi, beforeEach } from "vitest";
import { FeishuTransport } from "./feishu.js";
import {
  extractTextFromFeishuMessage,
  stripFeishuMentions,
  isBotMentioned,
  getFeishuSessionKey,
} from "./feishu.js";
import type { FeishuMessageEvent } from "./feishu.js";
import type { AgentManager, SessionStore, AgentInstance } from "../core/types.js";
import { textContent } from "../core/types.js";

// ---------------------------------------------------------------------------
// Mock @larksuiteoapi/node-sdk
// ---------------------------------------------------------------------------

const mockMessageCreate = vi.fn().mockResolvedValue({ code: 0 });
const mockRequest = vi.fn().mockResolvedValue({
  data: { bot: { open_id: "bot-open-id-123", app_name: "TestBot" } },
});

vi.mock("@larksuiteoapi/node-sdk", () => {
  const mockClient = {
    im: {
      message: {
        create: (...args: unknown[]) => mockMessageCreate(...args),
      },
    },
    request: (...args: unknown[]) => mockRequest(...args),
  };

  return {
    Client: vi.fn(() => mockClient),
    WSClient: vi.fn(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    })),
    EventDispatcher: vi.fn(() => ({
      register: vi.fn().mockReturnThis(),
    })),
    Domain: {
      Feishu: 0,
      Lark: 1,
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
    findByKey: vi.fn().mockResolvedValue(undefined),
    addMessage: vi.fn(),
    getMessages: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
  };
}

function makeEvent(overrides: Partial<FeishuMessageEvent> = {}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: "user-open-id-1",
        user_id: "user-id-1",
        union_id: "union-id-1",
      },
      sender_type: "user",
      tenant_key: "tenant-1",
    },
    message: {
      message_id: "msg-123",
      create_time: "1700000000000",
      chat_id: "chat-id-1",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      ...overrides.message,
    },
    ...overrides,
  } as FeishuMessageEvent;
}

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe("extractTextFromFeishuMessage", () => {
  it("extracts text from valid JSON content", () => {
    expect(extractTextFromFeishuMessage('{"text":"hello world"}')).toBe("hello world");
  });

  it("extracts text with @mentions", () => {
    expect(extractTextFromFeishuMessage('{"text":"@_user_1 hello"}')).toBe("@_user_1 hello");
  });

  it("returns empty string for invalid JSON", () => {
    expect(extractTextFromFeishuMessage("not json")).toBe("");
  });

  it("returns empty string for missing text field", () => {
    expect(extractTextFromFeishuMessage('{"type":"image"}')).toBe("");
  });

  it("returns empty string for non-string text field", () => {
    expect(extractTextFromFeishuMessage('{"text":123}')).toBe("");
  });

  it("handles empty text", () => {
    expect(extractTextFromFeishuMessage('{"text":""}')).toBe("");
  });

  it("handles text with special characters", () => {
    expect(extractTextFromFeishuMessage('{"text":"hello\\nworld"}')).toBe("hello\nworld");
  });
});

describe("stripFeishuMentions", () => {
  it("strips single @mention", () => {
    expect(stripFeishuMentions("@_user_1 hello")).toBe("hello");
  });

  it("strips multiple @mentions", () => {
    expect(stripFeishuMentions("@_user_1 @_user_2 hello world")).toBe("hello world");
  });

  it("leaves text without mentions unchanged", () => {
    expect(stripFeishuMentions("hello world")).toBe("hello world");
  });

  it("handles mention-only text (returns empty)", () => {
    expect(stripFeishuMentions("@_user_1")).toBe("");
  });

  it("handles mention in middle of text", () => {
    expect(stripFeishuMentions("hey @_user_1 how are you")).toBe("hey  how are you");
  });

  it("does not strip email-like patterns", () => {
    expect(stripFeishuMentions("contact user@example.com")).toBe("contact user@example.com");
  });
});

describe("isBotMentioned", () => {
  it("returns true when bot is mentioned", () => {
    const event = makeEvent({
      message: {
        message_id: "msg-1",
        create_time: "1700000000000",
        chat_id: "chat-1",
        chat_type: "group",
        message_type: "text",
        content: '{"text":"@_user_1 hello"}',
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: "bot-open-id-123", user_id: "bot-user-1" },
            name: "TestBot",
          },
        ],
      },
    });

    expect(isBotMentioned(event, "bot-open-id-123")).toBe(true);
  });

  it("returns false when bot is not mentioned", () => {
    const event = makeEvent({
      message: {
        message_id: "msg-1",
        create_time: "1700000000000",
        chat_id: "chat-1",
        chat_type: "group",
        message_type: "text",
        content: '{"text":"@_user_1 hello"}',
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: "other-user-id", user_id: "other-user-1" },
            name: "OtherUser",
          },
        ],
      },
    });

    expect(isBotMentioned(event, "bot-open-id-123")).toBe(false);
  });

  it("returns false when no mentions", () => {
    const event = makeEvent();
    expect(isBotMentioned(event, "bot-open-id-123")).toBe(false);
  });

  it("returns false with empty mentions array", () => {
    const event = makeEvent({
      message: {
        message_id: "msg-1",
        create_time: "1700000000000",
        chat_id: "chat-1",
        chat_type: "group",
        message_type: "text",
        content: '{"text":"hello"}',
        mentions: [],
      },
    });

    expect(isBotMentioned(event, "bot-open-id-123")).toBe(false);
  });
});

describe("getFeishuSessionKey", () => {
  it("generates DM session key for p2p chat", () => {
    const event = makeEvent({
      message: {
        message_id: "msg-1",
        create_time: "1700000000000",
        chat_id: "chat-1",
        chat_type: "p2p",
        message_type: "text",
        content: '{"text":"hello"}',
      },
    });

    const key = getFeishuSessionKey("bot-123", event, "default");
    expect(key).toBe("feishu:bot-123:dm:user-open-id-1:default");
  });

  it("generates group session key for group chat", () => {
    const event = makeEvent({
      message: {
        message_id: "msg-1",
        create_time: "1700000000000",
        chat_id: "chat-group-1",
        chat_type: "group",
        message_type: "text",
        content: '{"text":"hello"}',
      },
    });

    const key = getFeishuSessionKey("bot-123", event, "default");
    expect(key).toBe("feishu:bot-123:group:chat-group-1:default");
  });

  it("generates thread session key for threaded message", () => {
    const event = makeEvent({
      message: {
        message_id: "msg-1",
        create_time: "1700000000000",
        chat_id: "chat-group-1",
        thread_id: "thread-1",
        chat_type: "group",
        message_type: "text",
        content: '{"text":"hello"}',
      },
    });

    const key = getFeishuSessionKey("bot-123", event, "agent-1");
    expect(key).toBe("feishu:bot-123:thread:thread-1:agent-1");
  });

  it("uses unknown for missing sender open_id in DM", () => {
    const event = makeEvent({
      sender: {
        sender_id: {},
        sender_type: "user",
      },
      message: {
        message_id: "msg-1",
        create_time: "1700000000000",
        chat_id: "chat-1",
        chat_type: "p2p",
        message_type: "text",
        content: '{"text":"hello"}',
      },
    });

    const key = getFeishuSessionKey("bot-123", event, "default");
    expect(key).toBe("feishu:bot-123:dm:unknown:default");
  });
});

// ---------------------------------------------------------------------------
// FeishuTransport class tests
// ---------------------------------------------------------------------------

describe("FeishuTransport", () => {
  let transport: FeishuTransport;
  let agentManager: AgentManager;
  let sessionStore: SessionStore;

  beforeEach(() => {
    vi.clearAllMocks();
    agentManager = createMockAgentManager();
    sessionStore = createMockSessionStore();
    transport = new FeishuTransport({
      appId: "test-app-id",
      appSecret: "test-app-secret",
      agentManager,
      sessionStore,
      defaultAgentId: "default",
    });
  });

  describe("constructor", () => {
    it("throws when appId is missing", () => {
      expect(
        () =>
          new FeishuTransport({
            appId: "",
            appSecret: "secret",
            agentManager,
            sessionStore,
          }),
      ).toThrow("appId is required");
    });

    it("throws when appSecret is missing", () => {
      expect(
        () =>
          new FeishuTransport({
            appId: "app-id",
            appSecret: "",
            agentManager,
            sessionStore,
          }),
      ).toThrow("appSecret is required");
    });

    it("creates with valid config", () => {
      expect(transport).toBeDefined();
    });

    it("accepts lark domain", () => {
      const larkTransport = new FeishuTransport({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        agentManager,
        sessionStore,
        domain: "lark",
      });
      expect(larkTransport).toBeDefined();
    });
  });

  describe("start", () => {
    it("starts WebSocket client and fetches bot info", async () => {
      await transport.start();

      const { WSClient } = await import("@larksuiteoapi/node-sdk");
      const mockWsClient = (WSClient as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

      expect(mockWsClient.start).toHaveBeenCalledWith({
        eventDispatcher: expect.anything(),
      });
      expect(mockRequest).toHaveBeenCalledWith({
        url: "/bot/v3/info",
        method: "GET",
      });
    });
  });

  describe("stop", () => {
    it("closes the WebSocket client", async () => {
      await transport.start();
      await transport.stop();

      const { WSClient } = await import("@larksuiteoapi/node-sdk");
      const mockWsClient = (WSClient as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

      expect(mockWsClient.close).toHaveBeenCalled();
    });
  });

  describe("handleMessage", () => {
    it("processes a group message when bot is mentioned", async () => {
      await transport.start();

      const event = makeEvent({
        message: {
          message_id: "msg-1",
          create_time: "1700000000000",
          chat_id: "chat-group-1",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 hello bot" }),
          mentions: [
            {
              key: "@_user_1",
              id: { open_id: "bot-open-id-123" },
              name: "TestBot",
            },
          ],
        },
      });

      // Call the private handleMessage method
      await (
        transport as unknown as {
          handleMessage: (event: FeishuMessageEvent) => Promise<void>;
        }
      ).handleMessage(event);

      // Agent should have been called
      const agent = agentManager.get("default")!;
      expect(agent.prompt).toHaveBeenCalled();

      // Session should have been created
      expect(sessionStore.create).toHaveBeenCalledWith("default", expect.objectContaining({
        transport: "feishu",
        channelId: "chat-group-1",
      }));

      // User message should have been stored
      expect(sessionStore.addMessage).toHaveBeenCalledWith(
        "session-123",
        expect.objectContaining({
          role: "user",
          content: textContent("hello bot"),
        }),
      );

      // Response should have been sent
      expect(mockMessageCreate).toHaveBeenCalledWith({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: "chat-group-1",
          msg_type: "text",
          content: JSON.stringify({ text: "Hello world!" }),
        },
      });
    });

    it("processes a DM message without mention", async () => {
      await transport.start();

      const event = makeEvent({
        message: {
          message_id: "msg-1",
          create_time: "1700000000000",
          chat_id: "chat-dm-1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
      });

      await (
        transport as unknown as {
          handleMessage: (event: FeishuMessageEvent) => Promise<void>;
        }
      ).handleMessage(event);

      const agent = agentManager.get("default")!;
      expect(agent.prompt).toHaveBeenCalled();
    });

    it("ignores non-text messages", async () => {
      await transport.start();

      const event = makeEvent({
        message: {
          message_id: "msg-1",
          create_time: "1700000000000",
          chat_id: "chat-1",
          chat_type: "group",
          message_type: "image",
          content: '{"image_key":"img_123"}',
        },
      });

      await (
        transport as unknown as {
          handleMessage: (event: FeishuMessageEvent) => Promise<void>;
        }
      ).handleMessage(event);

      const agent = agentManager.get("default")!;
      expect(agent.prompt).not.toHaveBeenCalled();
    });

    it("ignores group messages when bot is not mentioned", async () => {
      await transport.start();

      const event = makeEvent({
        message: {
          message_id: "msg-1",
          create_time: "1700000000000",
          chat_id: "chat-group-1",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "hello everyone" }),
        },
      });

      await (
        transport as unknown as {
          handleMessage: (event: FeishuMessageEvent) => Promise<void>;
        }
      ).handleMessage(event);

      const agent = agentManager.get("default")!;
      expect(agent.prompt).not.toHaveBeenCalled();
    });

    it("stores error message when agent ends with error", async () => {
      const erroringAgent: AgentInstance = {
        prompt: vi.fn(async function* () {
          yield {
            type: "agent_end" as const,
            messages: [],
            stopReason: "error",
            errorMessage: "API error",
          };
        }),
        abort: vi.fn(),
        steer: vi.fn(),
        followUp: vi.fn(),
      };

      agentManager.get = vi.fn(() => erroringAgent);

      await transport.start();

      const event = makeEvent({
        message: {
          message_id: "msg-1",
          create_time: "1700000000000",
          chat_id: "chat-dm-1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
      });

      await (
        transport as unknown as {
          handleMessage: (event: FeishuMessageEvent) => Promise<void>;
        }
      ).handleMessage(event);

      expect(sessionStore.addMessage).toHaveBeenCalledWith(
        "session-123",
        expect.objectContaining({
          role: "assistant",
          content: textContent("❌ API error"),
          metadata: { isError: true },
        }),
      );

      expect(mockMessageCreate).toHaveBeenCalledWith({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: "chat-dm-1",
          msg_type: "text",
          content: JSON.stringify({ text: "❌ API error" }),
        },
      });
    });
  });

  describe("agent routing", () => {
    it("routes to agent via mention bindings", async () => {
      const specialAgent: AgentInstance = {
        prompt: vi.fn(async function* () {
          yield { type: "text_delta" as const, text: "Special!" };
          yield { type: "agent_end" as const, messages: [] };
        }),
        abort: vi.fn(),
        steer: vi.fn(),
        followUp: vi.fn(),
      };

      const boundTransport = new FeishuTransport({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        agentManager,
        sessionStore,
        defaultAgentId: "default",
        agentBindings: { "special-bot-id": "special-agent" },
      });

      agentManager.get = vi.fn((id: string) => {
        if (id === "special-agent") return specialAgent;
        return undefined;
      });

      await boundTransport.start();

      const event = makeEvent({
        message: {
          message_id: "msg-1",
          create_time: "1700000000000",
          chat_id: "chat-1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 hello" }),
          mentions: [
            {
              key: "@_user_1",
              id: { open_id: "special-bot-id" },
              name: "SpecialBot",
            },
          ],
        },
      });

      await (
        boundTransport as unknown as {
          handleMessage: (event: FeishuMessageEvent) => Promise<void>;
        }
      ).handleMessage(event);

      expect(agentManager.get).toHaveBeenCalledWith("special-agent");
      expect(specialAgent.prompt).toHaveBeenCalled();
    });
  });

  describe("message chunking", () => {
    it("chunks long messages", () => {
      const chunkMessage = (transport as unknown as {
        chunkMessage: (s: string, n?: number) => string[];
      }).chunkMessage.bind(transport);

      const shortMsg = "Hello world";
      expect(chunkMessage(shortMsg)).toEqual(["Hello world"]);

      const longMsg = "a".repeat(5000);
      const chunks = chunkMessage(longMsg);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c: string) => c.length <= 4000)).toBe(true);
    });
  });

  describe("session recovery", () => {
    it("reuses existing session", async () => {
      sessionStore.findByKey = vi.fn().mockResolvedValue({
        id: "existing-session",
        agentId: "default",
        lastActiveAt: new Date(),
      });

      await transport.start();

      const event = makeEvent({
        message: {
          message_id: "msg-1",
          create_time: "1700000000000",
          chat_id: "chat-dm-1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello again" }),
        },
      });

      await (
        transport as unknown as {
          handleMessage: (event: FeishuMessageEvent) => Promise<void>;
        }
      ).handleMessage(event);

      // Should not create a new session
      expect(sessionStore.create).not.toHaveBeenCalled();

      // Should add message to existing session
      expect(sessionStore.addMessage).toHaveBeenCalledWith(
        "existing-session",
        expect.objectContaining({ role: "user" }),
      );
    });
  });
});
