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

function createDefaultMockModel() {
  return {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 64000,
  };
}

vi.mock("@mariozechner/pi-agent-core", () => ({
  Agent: vi.fn(() => mockAgent),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: vi.fn().mockImplementation(() => createDefaultMockModel()),
}));

// Import after mocks
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { PiMonoCore } from "./pi-mono.js";
import { textContent } from "./types.js";
import { ToolRegistry } from "./tools.js";

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
  vi.mocked(Agent).mockClear();
  mockAgent.subscribe.mockClear().mockReturnValue(vi.fn());
  mockAgent.prompt.mockClear().mockResolvedValue(undefined);
  mockAgent.abort.mockClear();
  mockAgent.steer.mockClear();
  mockAgent.followUp.mockClear();
  vi.mocked(getModel).mockReset().mockImplementation((() => createDefaultMockModel()) as unknown as typeof getModel);
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
    const msg: Message = { role: "user", content: textContent("hi"), timestamp: 5000 };

    instance.steer(msg);

    expect(mockAgent.steer).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: textContent("hi"), timestamp: 5000 }),
    );
  });

  it("followUp() delegates to the underlying Agent with mapped message", () => {
    const core = new PiMonoCore();
    const instance = core.createAgent(makeConfig());
    const msg: Message = { role: "user", content: textContent("follow up") };

    instance.followUp(msg);

    expect(mockAgent.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: textContent("follow up") }),
    );
  });

  it("preserves api metadata when overriding baseUrl for proxy providers", () => {
    const proxiedModel = Object.create(null, {
      id: { value: "claude-opus-4.5", enumerable: true },
      name: { value: "Claude Opus 4.5", enumerable: true },
      api: { value: "anthropic-messages", enumerable: false },
      provider: { value: "anthropic", enumerable: false },
      baseUrl: { value: "https://api.anthropic.com", enumerable: true },
      reasoning: { value: true, enumerable: true },
      input: { value: ["text", "image"], enumerable: true },
      cost: {
        value: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        enumerable: true,
      },
      contextWindow: { value: 200000, enumerable: true },
      maxTokens: { value: 64000, enumerable: true },
    });

    vi.mocked(getModel).mockReturnValueOnce(proxiedModel);

    const core = new PiMonoCore();
    core.createAgent(
      makeConfig({
        provider: {
          type: "anthropic-proxy",
          baseUrl: "https://copilot-portal.azurewebsites.net",
          model: "claude-opus-4.5",
        },
      }),
    );

    expect(vi.mocked(Agent)).toHaveBeenCalledWith(
      expect.objectContaining({
        initialState: expect.objectContaining({
          model: expect.objectContaining({
            id: "claude-opus-4.5",
            api: "anthropic-messages",
            provider: "anthropic",
            baseUrl: "https://copilot-portal.azurewebsites.net",
          }),
        }),
      }),
    );
  });

  it("injects Authorization header for anthropic proxy providers", () => {
    const core = new PiMonoCore();
    core.createAgent(
      makeConfig({
        provider: {
          type: "anthropic-proxy",
          baseUrl: "https://copilot-portal.azurewebsites.net",
          model: "claude-opus-4.5",
          apiKey: "proxy-token",
        },
      }),
    );

    expect(vi.mocked(Agent)).toHaveBeenCalledWith(
      expect.objectContaining({
        initialState: expect.objectContaining({
          model: expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: "Bearer proxy-token",
            }),
          }),
        }),
      }),
    );
  });

  it("binds tool registries per agent instead of reusing the last one globally", () => {
    const core = new PiMonoCore();

    const registryA = new ToolRegistry();
    registryA.register(
      { name: "read_file", description: "Read file", parameters: {} },
      async () => "a",
    );

    const registryB = new ToolRegistry();
    registryB.register(
      { name: "list_dir", description: "List dir", parameters: {} },
      async () => "b",
    );

    core.setToolRegistry("agent-a", registryA);
    core.setToolRegistry("agent-b", registryB);

    core.createAgent(makeConfig({ id: "agent-a" }));
    core.createAgent(makeConfig({ id: "agent-b" }));
    core.createAgent(makeConfig({ id: "agent-a", name: "Agent A Reloaded" }));

    const agentCalls = vi.mocked(Agent).mock.calls;
    const lastThreeCalls = agentCalls.slice(-3);

    expect(lastThreeCalls[0][0]).toEqual(
      expect.objectContaining({
        initialState: expect.objectContaining({
          tools: [expect.objectContaining({ name: "read_file" })],
        }),
      }),
    );
    expect(lastThreeCalls[1][0]).toEqual(
      expect.objectContaining({
        initialState: expect.objectContaining({
          tools: [expect.objectContaining({ name: "list_dir" })],
        }),
      }),
    );
    expect(lastThreeCalls[2][0]).toEqual(
      expect.objectContaining({
        initialState: expect.objectContaining({
          tools: [expect.objectContaining({ name: "read_file" })],
        }),
      }),
    );
  });

  it("merges configured proxy headers with existing model headers", () => {
    vi.mocked(getModel).mockImplementationOnce((() => ({
      ...createDefaultMockModel(),
      headers: { "X-Model-Header": "base" },
    })) as unknown as typeof getModel);

    const core = new PiMonoCore();
    core.createAgent(
      makeConfig({
        provider: {
          type: "anthropic-proxy",
          baseUrl: "https://copilot-portal.azurewebsites.net",
          model: "claude-opus-4.5",
          apiKey: "proxy-token",
          headers: { "X-Proxy-Header": "override" },
        },
      }),
    );

    expect(vi.mocked(Agent)).toHaveBeenCalledWith(
      expect.objectContaining({
        initialState: expect.objectContaining({
          model: expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: "Bearer proxy-token",
              "X-Model-Header": "base",
              "X-Proxy-Header": "override",
            }),
          }),
        }),
      }),
    );
  });

  it("falls back to canonical anthropic model metadata for dotted proxy model ids", () => {
    vi.mocked(getModel).mockImplementation(((provider: string, modelId: string) => {
      if (provider === "anthropic" && modelId === "claude-opus-4-5") {
        return {
          id: "claude-opus-4-5",
          name: "Claude Opus 4.5 (latest)",
          api: "anthropic-messages",
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
          contextWindow: 200000,
          maxTokens: 64000,
        };
      }

      return undefined;
    }) as typeof getModel);

    const core = new PiMonoCore();
    core.createAgent(
      makeConfig({
        provider: {
          type: "anthropic-proxy",
          baseUrl: "https://copilot-portal.azurewebsites.net",
          model: "claude-opus-4.5",
        },
      }),
    );

    expect(vi.mocked(Agent)).toHaveBeenCalledWith(
      expect.objectContaining({
        initialState: expect.objectContaining({
          model: expect.objectContaining({
            id: "claude-opus-4.5",
            api: "anthropic-messages",
            provider: "anthropic",
            baseUrl: "https://copilot-portal.azurewebsites.net",
          }),
        }),
      }),
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

  it("maps prompt history messages to content blocks", async () => {
    setupEvents([]);
    const core = new PiMonoCore();
    const instance = core.createAgent(makeConfig());

    for await (const _ev of instance.prompt([
      { role: "user", content: textContent("hello"), timestamp: 1000 },
      { role: "assistant", content: textContent("hi there"), timestamp: 2000 },
      {
        role: "tool_result",
        content: [{ type: "tool_result", output: "tool output", toolCallId: "call-1", toolName: "readFile" }],
        timestamp: 3000,
      },
    ])) {
      void _ev;
    }

    expect(mockAgent.prompt).toHaveBeenCalledWith([
      {
        role: "user",
        content: textContent("hello"),
        timestamp: 1000,
      },
      {
        role: "assistant",
        content: textContent("hi there"),
        timestamp: 2000,
      },
      {
        role: "toolResult",
        content: "tool output",
        timestamp: 3000,
        toolCallId: "call-1",
        toolName: "readFile",
      },
    ]);
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
          {
            role: "toolResult",
            content: "result data",
            timestamp: 3000,
            toolCallId: "call-2",
            toolName: "readFile",
          },
        ],
      },
    ]);

    expect(events).toHaveLength(1);
    const agentEnd = events[0] as Extract<AgentEvent, { type: "agent_end" }>;
    expect(agentEnd.type).toBe("agent_end");
    expect(agentEnd.messages).toHaveLength(3);
    expect(agentEnd.messages[0].role).toBe("user");
    expect(agentEnd.messages[0].content).toEqual(textContent("hi"));
    expect(agentEnd.messages[1].role).toBe("assistant");
    expect(agentEnd.messages[1].content).toEqual(textContent("hello"));
    expect(agentEnd.messages[2].role).toBe("tool_result");
    expect(agentEnd.messages[2].content).toEqual([
      { type: "text", text: "result data" },
    ]);
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
    instance.steer({ role: "user", content: textContent("hi") });

    expect(mockAgent.steer).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user" }),
    );
  });

  it("maps assistant role to assistant", () => {
    const core = new PiMonoCore();
    const instance = core.createAgent(makeConfig());
    instance.steer({ role: "assistant", content: textContent("hey") });

    expect(mockAgent.steer).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant" }),
    );
  });

  it("maps tool_result role to toolResult", () => {
    const core = new PiMonoCore();
    const instance = core.createAgent(makeConfig());
    instance.steer({
      role: "tool_result",
      content: [{ type: "tool_result", output: "output", toolCallId: "call-3", toolName: "runTool" }],
    });

    expect(mockAgent.steer).toHaveBeenCalledWith(
      expect.objectContaining({ role: "toolResult", content: "output", toolCallId: "call-3", toolName: "runTool" }),
    );
  });

  it("uses Date.now() when timestamp is not provided", () => {
    const now = 1700000000000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const core = new PiMonoCore();
    const instance = core.createAgent(makeConfig());
    instance.steer({ role: "user", content: textContent("test") });

    expect(mockAgent.steer).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: now }),
    );

    vi.restoreAllMocks();
  });
});
