// src/transports/feishu.test.ts — Unit tests for FeishuTransport

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FeishuTransport,
  extractTextFromFeishuMessage,
  buildFeishuSessionKey,
  type FeishuMessageEvent,
} from "./feishu.js";
import type { AgentManager, SessionStore, AgentInstance } from "../core/types.js";
import { textContent } from "../core/types.js";

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

function createMockAgentManager(): AgentManager {
  const mockInstance: AgentInstance = {
    prompt: vi.fn(async function* () {
      yield { type: "text_delta" as const, text: "Hello " };
      yield { type: "text_delta" as const, text: "from Feishu!" };
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
      id: "session-feishu-123",
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

describe("buildFeishuSessionKey", () => {
  it("builds correct session key for DM", () => {
    expect(buildFeishuSessionKey("app123", "user456", "agent1")).toBe(
      "feishu:app123:dm:user456:agent1",
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
});

describe("FeishuTransport", () => {
  let transport: FeishuTransport;
  let agentManager: AgentManager;
  let sessionStore: SessionStore;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedEventHandler = null;
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
          content: textContent("Hello bot"),
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
          content: textContent("Hello from Feishu!"),
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

    it("ignores group messages (M2.1 scope: DM only)", async () => {
      const event = createDMEvent({
        message: {
          message_id: "msg_123",
          create_time: "1700000000000",
          chat_id: "oc_group123",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "Hello" }),
        },
      });

      await capturedEventHandler!(event);
      expect(sessionStore.findByKey).not.toHaveBeenCalled();
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
      const errorAgent: AgentInstance = {
        prompt: vi.fn(async function* () {
          throw new Error("Agent crashed");
        }),
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
      const errorAgent: AgentInstance = {
        prompt: vi.fn(async function* () {
          yield {
            type: "agent_end" as const,
            messages: [],
            stopReason: "error",
            errorMessage: "API key invalid",
          };
        }),
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
        { role: "user" as const, content: textContent("Hi"), timestamp: 1000 },
        { role: "assistant" as const, content: textContent("Hello!"), timestamp: 2000 },
      ];

      sessionStore.findByKey = vi.fn().mockResolvedValue({
        id: "existing-session",
        agentId: "default",
        lastActiveAt: new Date(),
      });

      // getMessages returns previous history PLUS the new message we just added
      sessionStore.getMessages = vi.fn().mockResolvedValue([
        ...previousMessages,
        { role: "user" as const, content: textContent("Hello bot"), timestamp: 1700000000000 },
      ]);

      const event = createDMEvent();
      await capturedEventHandler!(event);

      const agent = agentManager.get("default")!;
      expect(agent.prompt).toHaveBeenCalledWith([
        ...previousMessages,
        expect.objectContaining({ role: "user", content: textContent("Hello bot") }),
      ]);
    });
  });
});
