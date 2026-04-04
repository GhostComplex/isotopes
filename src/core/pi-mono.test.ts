// src/core/pi-mono.test.ts — Unit tests for PiMonoCore
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentConfig, AgentEvent, Message } from "./types.js";

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const mockAgent = {
  subscribe: vi.fn(() => vi.fn()),
  prompt: vi.fn(() => Promise.resolve()),
  abort: vi.fn(),
  steer: vi.fn(),
  followUp: vi.fn(),
};

vi.mock("@mariozechner/pi-agent-core", () => ({
  Agent: vi.fn(() => mockAgent),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: vi.fn().mockReturnValue({
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
  }),
}));

// Import after mocks
import { PiMonoCore } from "./pi-mono.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: "test-agent",
    name: "Test Agent",
    systemPrompt: "You are a test agent.",
    ...overrides,
  };
}

function resetMocks() {
  mockAgent.subscribe.mockClear().mockReturnValue(vi.fn());
  mockAgent.prompt.mockClear().mockResolvedValue(undefined);
  mockAgent.abort.mockClear();
  mockAgent.steer.mockClear();
  mockAgent.followUp.mockClear();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PiMonoCore.createAgent", () => {
  beforeEach(resetMocks);

  it("returns an AgentInstance with prompt, abort, steer, followUp", () => {
    const core = new PiMonoCore();
    const instance = core.createAgent(makeConfig());

    expect(instance).toBeDefined();
    expect(typeof instance.prompt).toBe("function");
    expect(typeof instance.abort).toBe("function");
    expect(typeof instance.steer).toBe("function");
    expect(typeof instance.followUp).toBe("function");
  });

  it("abort() delegates to the underlying Agent", () => {
    const core = new PiMonoCore();
    const instance = core.createAgent(makeConfig());
    instance.abort();
    expect(mockAgent.abort).toHaveBeenCalledOnce();
  });

  it("steer() delegates to the underlying Agent with mapped message", () => {
    const core = new PiMonoCore();
    const instance = core.createAgent(makeConfig());
    const msg: Message = { role: "user", content: "hi", timestamp: 5000 };

    instance.steer(msg);

    expect(mockAgent.steer).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: "hi", timestamp: 5000 }),
    );
  });

  it("followUp() delegates to the underlying Agent with mapped message", () => {
    const core = new PiMonoCore();
    const instance = core.createAgent(makeConfig());
    const msg: Message = { role: "user", content: "follow up" };

    instance.followUp(msg);

    expect(mockAgent.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: "follow up" }),
    );
  });
});

describe("prompt() event mapping", () => {
  beforeEach(resetMocks);

  function setupEvents(coreEvents: unknown[]) {
    let listener: ((e: unknown) => void) | null = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockAgent.subscribe as any).mockImplementation((fn: (e: unknown) => void) => {
      listener = fn;
      return vi.fn();
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockAgent.prompt as any).mockImplementation(() => {
      for (const ev of coreEvents) {
        listener!(ev);
      }
      return Promise.resolve();
    });
  }

  async function collectEvents(coreEvents: unknown[]): Promise<AgentEvent[]> {
    setupEvents(coreEvents);
    const core = new PiMonoCore();
    const instance = core.createAgent(makeConfig());

    const collected: AgentEvent[] = [];
    for await (const ev of instance.prompt("hello")) {
      collected.push(ev);
    }
    return collected;
  }

  it("maps turn_start", async () => {
    const events = await collectEvents([{ type: "turn_start" }]);
    expect(events).toContainEqual({ type: "turn_start" });
  });

  it("maps turn_end", async () => {
    const events = await collectEvents([
      { type: "turn_end", message: {}, toolResults: [] },
    ]);
    expect(events).toContainEqual({ type: "turn_end" });
  });

  it("maps message_update with text_delta", async () => {
    const events = await collectEvents([
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "hello world" },
      },
    ]);
    expect(events).toContainEqual({ type: "text_delta", text: "hello world" });
  });

  it("maps tool_execution_start to tool_call", async () => {
    const events = await collectEvents([
      {
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "readFile",
        args: { path: "/foo" },
      },
    ]);
    expect(events).toContainEqual({
      type: "tool_call",
      id: "tc-1",
      name: "readFile",
      args: { path: "/foo" },
    });
  });

  it("maps tool_execution_end to tool_result", async () => {
    const events = await collectEvents([
      {
        type: "tool_execution_end",
        toolCallId: "tc-2",
        toolName: "readFile",
        result: "file contents",
        isError: false,
      },
    ]);
    expect(events).toContainEqual({
      type: "tool_result",
      id: "tc-2",
      output: "file contents",
      isError: false,
    });
  });

  it("maps agent_end with converted messages", async () => {
    const events = await collectEvents([
      {
        type: "agent_end",
        messages: [
          { role: "user", content: "hi", timestamp: 1000 },
          { role: "assistant", content: "hello", timestamp: 2000 },
          { role: "toolResult", content: "result data", timestamp: 3000 },
        ],
      },
    ]);

    expect(events).toHaveLength(1);
    const agentEnd = events[0] as Extract<AgentEvent, { type: "agent_end" }>;
    expect(agentEnd.type).toBe("agent_end");
    expect(agentEnd.messages).toHaveLength(3);
    expect(agentEnd.messages[0].role).toBe("user");
    expect(agentEnd.messages[1].role).toBe("assistant");
    expect(agentEnd.messages[2].role).toBe("tool_result");
  });

  it("maps agent_end error metadata from assistant message", async () => {
    const events = await collectEvents([
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            timestamp: 2000,
            stopReason: "error",
            errorMessage: "No API provider registered for api: undefined",
          },
        ],
      },
    ]);

    const agentEnd = events[0] as Extract<AgentEvent, { type: "agent_end" }>;
    expect(agentEnd.stopReason).toBe("error");
    expect(agentEnd.errorMessage).toBe("No API provider registered for api: undefined");
    expect(agentEnd.messages[0].metadata).toEqual({
      stopReason: "error",
      errorMessage: "No API provider registered for api: undefined",
    });
  });

  it("skips unknown event types", async () => {
    const events = await collectEvents([
      { type: "agent_start" },
      { type: "message_start", message: {} },
      { type: "unknown_future_event" },
    ]);
    expect(events).toHaveLength(0);
  });

  it("handles multiple events in sequence", async () => {
    const events = await collectEvents([
      { type: "turn_start" },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "Hi" },
      },
      { type: "turn_end", message: {}, toolResults: [] },
    ]);

    expect(events).toHaveLength(3);
    expect(events.map((e) => e.type)).toEqual([
      "turn_start",
      "text_delta",
      "turn_end",
    ]);
  });

  it("unsubscribes after prompt completes", async () => {
    const unsub = vi.fn();
    mockAgent.subscribe.mockReturnValue(unsub);
    mockAgent.prompt.mockResolvedValue(undefined);

    const core = new PiMonoCore();
    const instance = core.createAgent(makeConfig());

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ev of instance.prompt("test")) {
      // consume
    }

    expect(unsub).toHaveBeenCalledOnce();
  });
});

describe("Message conversion", () => {
  beforeEach(resetMocks);

  it("maps user role to user", () => {
    const core = new PiMonoCore();
    const instance = core.createAgent(makeConfig());
    instance.steer({ role: "user", content: "hi" });

    expect(mockAgent.steer).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user" }),
    );
  });

  it("maps assistant role to assistant", () => {
    const core = new PiMonoCore();
    const instance = core.createAgent(makeConfig());
    instance.steer({ role: "assistant", content: "hey" });

    expect(mockAgent.steer).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant" }),
    );
  });

  it("maps tool_result role to toolResult", () => {
    const core = new PiMonoCore();
    const instance = core.createAgent(makeConfig());
    instance.steer({ role: "tool_result", content: "output" });

    expect(mockAgent.steer).toHaveBeenCalledWith(
      expect.objectContaining({ role: "toolResult" }),
    );
  });

  it("uses Date.now() when timestamp is not provided", () => {
    const now = 1700000000000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const core = new PiMonoCore();
    const instance = core.createAgent(makeConfig());
    instance.steer({ role: "user", content: "test" });

    expect(mockAgent.steer).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: now }),
    );

    vi.restoreAllMocks();
  });
});
