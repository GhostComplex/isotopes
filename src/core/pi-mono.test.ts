// src/core/pi-mono.test.ts — Unit tests for PiMonoCore
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentConfig, AgentEvent, AgentMessage } from "./types.js";
import { msgField } from "./messages.js";

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
import { PiMonoCore, stripOrphanedToolResults } from "./pi-mono.js";
import { ToolRegistry } from "./tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: "test-agent",
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    const msg: AgentMessage = { role: "user", content: "hi", timestamp: 5000 };

    instance.steer(msg);

    expect(mockAgent.steer).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: "hi", timestamp: 5000 }),
    );
  });

  it("followUp() delegates to the underlying Agent with mapped message", () => {
    const core = new PiMonoCore();
    const instance = core.createAgent(makeConfig());
    const msg = { role: "user", content: "follow up", timestamp: Date.now() } as unknown as AgentMessage as unknown as AgentMessage;

    instance.followUp(msg);

    expect(mockAgent.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: "follow up" }),
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

    const registryA = new ToolRegistry("test");
    registryA.register(
      { name: "read_file", description: "Read file", parameters: {} },
      async () => "a",
    );

    const registryB = new ToolRegistry("test");
    registryB.register(
      { name: "list_dir", description: "List dir", parameters: {} },
      async () => "b",
    );

    core.setToolRegistry("agent-a", registryA);
    core.setToolRegistry("agent-b", registryB);

    core.createAgent(makeConfig({ id: "agent-a" }));
    core.createAgent(makeConfig({ id: "agent-b" }));
    core.createAgent(makeConfig({ id: "agent-a" }));

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

    (mockAgent.subscribe as ReturnType<typeof vi.fn>).mockImplementation((fn: (e: unknown) => void) => {
      listener = fn;
      return vi.fn();
    });

    (mockAgent.prompt as ReturnType<typeof vi.fn>).mockImplementation(() => {
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

    const inputMsgs = [
      { role: "user", content: "hello", timestamp: 1000 } as unknown as AgentMessage,
      { role: "assistant", content: [{ type: "text", text: "hi there" }], timestamp: 2000 } as unknown as AgentMessage,
      { role: "toolResult", content: "tool output", toolCallId: "call-1", toolName: "readFile", timestamp: 3000 } as unknown as AgentMessage,
    ];

    for await (const _ev of instance.prompt(inputMsgs)) {
      void _ev;
    }

    // No conversion — messages pass through directly
    expect(mockAgent.prompt).toHaveBeenCalledWith(inputMsgs);
  });

  it("maps turn_end", async () => {
    const events = await collectEvents([
      { type: "turn_end", message: {}, toolResults: [] },
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "turn_end" }));
  });

  it("maps message_update with text_delta", async () => {
    const events = await collectEvents([
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "hello world" },
      },
    ]);
    expect(events).toContainEqual({ type: "message_update", message: {} as never, assistantMessageEvent: { type: "text_delta", delta: "hello world" } as never });
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
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_execution_start",
      toolCallId: "tc-1",
      toolName: "readFile",
      args: { path: "/foo" },
    }));
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
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_execution_end",
      toolCallId: "tc-2",
    }));
  });

  it("maps agent_end with converted messages", async () => {
    const events = await collectEvents([
      {
        type: "agent_end",
        messages: [
          { role: "user", content: "hi", timestamp: 1000 },
          { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2000 },
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
    expect(msgField(agentEnd.messages[0], "content")).toBe("hi");
    expect(agentEnd.messages[1].role).toBe("assistant");
    expect(msgField(agentEnd.messages[1], "content")).toEqual([{ type: "text", text: "hello" }]);
    expect(agentEnd.messages[2].role).toBe("toolResult");
    expect(msgField(agentEnd.messages[2], "content")).toBe("result data");
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
    expect(msgField(agentEnd.messages[agentEnd.messages.length-1], "stopReason")).toBe("error");
    expect(msgField(agentEnd.messages[agentEnd.messages.length-1], "errorMessage")).toBe("No API provider registered for api: undefined");
    expect(msgField(agentEnd.messages[0], "stopReason")).toBe("error");
    expect(msgField(agentEnd.messages[0], "errorMessage")).toBe("No API provider registered for api: undefined");
  });

  it("passes through all SDK event types without filtering", async () => {
    const events = await collectEvents([
      { type: "agent_start" },
      { type: "turn_start" },
    ]);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("agent_start");
    expect(events[1].type).toBe("turn_start");
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
      "message_update",
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

  it("queues concurrent prompts on the same agent instance", async () => {
    const listeners: Array<(e: unknown) => void> = [];
    (mockAgent.subscribe as ReturnType<typeof vi.fn>).mockImplementation((fn: (e: unknown) => void) => {
      listeners.push(fn);
      return vi.fn();
    });

    const firstPrompt = deferred<void>();
    const secondPrompt = deferred<void>();

    mockAgent.prompt
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockImplementationOnce(() => secondPrompt.promise);

    const core = new PiMonoCore();
    const instance = core.createAgent(makeConfig());

    const consume = async (iterable: AsyncIterable<AgentEvent>) => {
      const events: AgentEvent[] = [];
      for await (const event of iterable) {
        events.push(event);
      }
      return events;
    };

    const firstRun = consume(instance.prompt("first"));
    await Promise.resolve();

    const secondRun = consume(instance.prompt("second"));
    await Promise.resolve();
    await Promise.resolve();

    expect(mockAgent.prompt).toHaveBeenCalledTimes(1);
    expect(mockAgent.prompt).toHaveBeenNthCalledWith(1, "first");
    expect(mockAgent.subscribe).toHaveBeenCalledTimes(1);

    listeners[0]?.({ type: "agent_end", messages: [] });
    firstPrompt.resolve();
    await firstRun;

    await Promise.resolve();
    await Promise.resolve();

    expect(mockAgent.prompt).toHaveBeenCalledTimes(2);
    expect(mockAgent.prompt).toHaveBeenNthCalledWith(2, "second");
    expect(mockAgent.subscribe).toHaveBeenCalledTimes(2);

    listeners[1]?.({ type: "agent_end", messages: [] });
    secondPrompt.resolve();
    await secondRun;
  });

  it("releases queue and cleans up when agent.prompt() rejects", async () => {
    const listeners: Array<(e: unknown) => void> = [];
    const unsubs: Array<ReturnType<typeof vi.fn>> = [];

    (mockAgent.subscribe as ReturnType<typeof vi.fn>).mockImplementation((fn: (e: unknown) => void) => {
      listeners.push(fn);
      const unsub = vi.fn();
      unsubs.push(unsub);
      return unsub;
    });

    const firstPrompt = deferred<void>();
    const secondPrompt = deferred<void>();

    mockAgent.prompt
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockImplementationOnce(() => secondPrompt.promise);

    const core = new PiMonoCore();
    const instance = core.createAgent(makeConfig());

    const consume = async (iterable: AsyncIterable<AgentEvent>) => {
      const events: AgentEvent[] = [];
      for await (const event of iterable) {
        events.push(event);
      }
      return events;
    };

    // Start first prompt
    const firstRun = consume(instance.prompt("first"));
    await Promise.resolve();

    // Queue second prompt (should wait for first)
    const secondRun = consume(instance.prompt("second"));
    await Promise.resolve();
    await Promise.resolve();

    // First prompt is running, second is queued
    expect(mockAgent.prompt).toHaveBeenCalledTimes(1);
    expect(mockAgent.subscribe).toHaveBeenCalledTimes(1);

    // First prompt rejects with an error
    firstPrompt.reject(new Error("API rate limit exceeded"));

    // First run should throw
    await expect(firstRun).rejects.toThrow("API rate limit exceeded");

    // Queue should be released - second prompt should start
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockAgent.prompt).toHaveBeenCalledTimes(2);
    expect(mockAgent.prompt).toHaveBeenNthCalledWith(2, "second");
    expect(mockAgent.subscribe).toHaveBeenCalledTimes(2);

    // First subscription should have been cleaned up
    expect(unsubs[0]).toHaveBeenCalledOnce();

    // Complete second prompt normally
    listeners[1]?.({ type: "agent_end", messages: [] });
    secondPrompt.resolve();
    await secondRun;

    // Second subscription should also be cleaned up
    expect(unsubs[1]).toHaveBeenCalledOnce();
  });
});


// ---------------------------------------------------------------------------
// stripOrphanedToolResults (#146)
// ---------------------------------------------------------------------------

describe("stripOrphanedToolResults", () => {
  it("strips toolResult whose assistant was errored", () => {
    const messages = [
      { role: "user", content: "search for X", timestamp: 1000 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_ABC", name: "web_search" }],
        stopReason: "error",
        timestamp: 2000,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_ABC",
        content: "search results",
        timestamp: 3000,
      },
      { role: "user", content: "try again", timestamp: 4000 },
    ] as unknown[];

    const result = stripOrphanedToolResults(messages as import("@mariozechner/pi-agent-core").AgentMessage[]);

    expect(result).toHaveLength(3);
    expect(result.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("strips toolResult whose assistant was aborted", () => {
    const messages = [
      { role: "user", content: "do something", timestamp: 1000 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_XYZ", name: "shell" }],
        stopReason: "aborted",
        timestamp: 2000,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_XYZ",
        content: "output",
        timestamp: 3000,
      },
    ] as unknown[];

    const result = stripOrphanedToolResults(messages as import("@mariozechner/pi-agent-core").AgentMessage[]);

    expect(result).toHaveLength(2);
    expect(result.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("keeps toolResult whose assistant is not errored", () => {
    const messages = [
      { role: "user", content: "search for X", timestamp: 1000 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_OK", name: "web_search" }],
        stopReason: "end_turn",
        timestamp: 2000,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_OK",
        content: "results",
        timestamp: 3000,
      },
    ] as unknown[];

    const result = stripOrphanedToolResults(messages as import("@mariozechner/pi-agent-core").AgentMessage[]);

    expect(result).toHaveLength(3);
    expect(result.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
  });

  it("handles mixed valid and orphaned toolResults", () => {
    const messages = [
      { role: "user", content: "first", timestamp: 1000 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_GOOD", name: "readFile" }],
        timestamp: 2000,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_GOOD",
        content: "file contents",
        timestamp: 3000,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me search" },
          { type: "toolCall", id: "toolu_BAD", name: "web_search" },
        ],
        stopReason: "error",
        timestamp: 4000,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_BAD",
        content: "orphaned result",
        timestamp: 5000,
      },
      { role: "user", content: "continue", timestamp: 6000 },
    ] as unknown[];

    const result = stripOrphanedToolResults(messages as import("@mariozechner/pi-agent-core").AgentMessage[]);

    expect(result).toHaveLength(5);
    expect(result.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "user",
    ]);
    // The kept toolResult should be the valid one
    const keptToolResult = result[2] as unknown as { toolCallId: string };
    expect(keptToolResult.toolCallId).toBe("toolu_GOOD");
  });

  it("returns empty array for empty input", () => {
    const result = stripOrphanedToolResults([]);
    expect(result).toEqual([]);
  });

  it("passes through messages with no toolResults", () => {
    const messages = [
      { role: "user", content: "hello", timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2000 },
    ] as unknown[];

    const result = stripOrphanedToolResults(messages as import("@mariozechner/pi-agent-core").AgentMessage[]);

    expect(result).toHaveLength(2);
  });
});

describe("transformContext hook (#146)", () => {
  beforeEach(resetMocks);

  it("always passes transformContext to the Agent constructor", () => {
    const core = new PiMonoCore();
    core.createAgent(makeConfig()); // no compaction config

    expect(vi.mocked(Agent)).toHaveBeenCalledWith(
      expect.objectContaining({
        transformContext: expect.any(Function),
      }),
    );
  });

  it("passes transformContext even with compaction enabled", () => {
    const core = new PiMonoCore();
    core.createAgent(makeConfig({
      compaction: { mode: "safeguard" },
    }));

    expect(vi.mocked(Agent)).toHaveBeenCalledWith(
      expect.objectContaining({
        transformContext: expect.any(Function),
      }),
    );
  });
});
