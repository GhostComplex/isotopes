import { describe, it, expect, vi } from "vitest";
import type { AgentConfig, ProviderConfig } from "../../core/types.js";
import { ToolRegistry } from "../../core/tools.js";
import type { RunEvent } from "../types.js";
import { BuiltinRunner } from "./builtin.js";
import type { AgentServiceCache, PiMonoCore } from "../../core/pi-mono.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";

function makeRegistry(names: string[]): ToolRegistry {
  const r = new ToolRegistry("test");
  for (const name of names) {
    r.register(
      { name, description: name, parameters: { type: "object", properties: {} } },
      async () => `result of ${name}`,
    );
  }
  return r;
}

function fakeProvider(): ProviderConfig {
  return { type: "anthropic", model: "claude-sonnet-4-5" };
}

function makeCore(events: AgentEvent[]): {
  core: PiMonoCore;
  setIds: string[];
  clearedIds: string[];
  capturedConfig: AgentConfig | undefined;
  abortCalled: number;
} {
  const setIds: string[] = [];
  const clearedIds: string[] = [];
  let capturedConfig: AgentConfig | undefined;
  let abortCalled = 0;

  const mockSession = {
    subscribe: vi.fn((cb: (event: { type: string }) => void) => {
      (mockSession as unknown as Record<string, unknown>)._cb = cb;
      return () => {};
    }),
    prompt: vi.fn(async () => {
      const cb = (mockSession as unknown as Record<string, (event: { type: string }) => void>)._cb;
      if (cb) {
        for (const e of events) cb(e);
      }
    }),
    abort: vi.fn(() => { abortCalled++; }),
    dispose: vi.fn(),
    agent: { state: { systemPrompt: "" } },
  };

  const cache = {
    createSession: vi.fn().mockResolvedValue(mockSession),
  } as unknown as AgentServiceCache;

  const core = {
    setToolRegistry: (id: string) => {
      setIds.push(id);
    },
    clearToolRegistry: (id: string) => {
      clearedIds.push(id);
    },
    createServiceCache: (config: AgentConfig) => {
      capturedConfig = config;
      return cache;
    },
  } as unknown as PiMonoCore;

  return {
    core,
    setIds,
    clearedIds,
    get capturedConfig() {
      return capturedConfig;
    },
    get abortCalled() {
      return abortCalled;
    },
  };
}

async function collect(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("BuiltinRunner", () => {
  it("yields error+done(1) when options.builtin is missing", async () => {
    const harness = makeCore([]);
    const runner = new BuiltinRunner(harness.core);
    const out = await collect(
      runner.run(
        "task-1",
        { agentId: "test-agent", prompt: "hi", cwd: "/tmp" },
        { abort: new AbortController().signal },
      ),
    );
    expect(out[0].type).toBe("run:error");
    expect(out.at(-1)).toEqual({ type: "run:done", exitCode: 1 });
  });

  it("registers a filtered tool registry, runs, and clears it", async () => {
    const harness = makeCore([
      { type: "turn_start" } as AgentEvent,
      { type: "message_update", message: {} as never, assistantMessageEvent: { type: "text_delta", delta: "ok" } as never } as AgentEvent,
      { type: "turn_end", message: {} as never, toolResults: [] } as AgentEvent,
      { type: "agent_end", messages: [] } as AgentEvent,
    ]);
    const runner = new BuiltinRunner(harness.core);
    const tools = makeRegistry(["read_file", "write_file", "shell"]);

    const out = await collect(
      runner.run(
        "task-2",
        {
          agentId: "test-agent",
          prompt: "do thing",
          cwd: "/tmp",
          builtin: { mode: "subagent", provider: fakeProvider(), tools },
        },
        { abort: new AbortController().signal },
      ),
    );

    expect(harness.setIds).toHaveLength(1);
    expect(harness.setIds[0]).toMatch(/^agent-builtin-task-2-/);
    expect(harness.clearedIds).toEqual(harness.setIds);

    expect(harness.capturedConfig?.compaction).toEqual({ mode: "off" });
    expect(harness.capturedConfig?.provider?.type).toBe("anthropic");

    expect(out).toEqual([
      { type: "run:message", content: "ok" },
      { type: "run:done", exitCode: 0 },
    ]);
  });

  it("aborts the underlying session when the abort signal fires", async () => {
    const harness = makeCore([
      { type: "turn_start" } as AgentEvent,
      { type: "agent_end", messages: [] } as AgentEvent,
    ]);
    const runner = new BuiltinRunner(harness.core);
    const ac = new AbortController();
    ac.abort();

    await collect(
      runner.run(
        "task-3",
        {
          agentId: "test-agent",
          prompt: "p",
          cwd: "/tmp",
          builtin: { mode: "subagent", provider: fakeProvider(), tools: makeRegistry([]) },
        },
        { abort: ac.signal },
      ),
    );

    expect(harness.abortCalled).toBeGreaterThanOrEqual(1);
  });

  it("skips empty text messages", async () => {
    const harness = makeCore([
      { type: "turn_start" } as AgentEvent,
      { type: "message_update", message: {} as never, assistantMessageEvent: { type: "text_delta", delta: "   " } as never } as AgentEvent,
      { type: "turn_end", message: {} as never, toolResults: [] } as AgentEvent,
      { type: "agent_end", messages: [] } as AgentEvent,
    ]);
    const runner = new BuiltinRunner(harness.core);
    const out = await collect(
      runner.run("task-skip", {
        agentId: "test-agent", prompt: "p", cwd: "/tmp",
        builtin: { mode: "subagent", provider: fakeProvider(), tools: makeRegistry([]) },
      }, { abort: new AbortController().signal }),
    );
    expect(out).toEqual([{ type: "run:done", exitCode: 0 }]);
  });

  it("translates tool_execution_start to run:tool_use", async () => {
    const harness = makeCore([
      { type: "tool_execution_start", toolCallId: "1", toolName: "shell", args: { cmd: "ls" } } as AgentEvent,
      { type: "agent_end", messages: [] } as AgentEvent,
    ]);
    const runner = new BuiltinRunner(harness.core);
    const out = await collect(
      runner.run("task-tool", {
        agentId: "test-agent", prompt: "p", cwd: "/tmp",
        builtin: { mode: "subagent", provider: fakeProvider(), tools: makeRegistry([]) },
      }, { abort: new AbortController().signal }),
    );
    expect(out[0]).toEqual({ type: "run:tool_use", toolName: "shell", toolInput: { cmd: "ls" } });
  });

  it("translates tool_execution_end to run:tool_result with error flag", async () => {
    const harness = makeCore([
      { type: "tool_execution_end", toolCallId: "1", toolName: "test", result: "ok", isError: false } as AgentEvent,
      { type: "tool_execution_end", toolCallId: "2", toolName: "test", result: "boom", isError: true } as AgentEvent,
      { type: "agent_end", messages: [] } as AgentEvent,
    ]);
    const runner = new BuiltinRunner(harness.core);
    const out = await collect(
      runner.run("task-tresult", {
        agentId: "test-agent", prompt: "p", cwd: "/tmp",
        builtin: { mode: "subagent", provider: fakeProvider(), tools: makeRegistry([]) },
      }, { abort: new AbortController().signal }),
    );
    expect(out[0]).toEqual({ type: "run:tool_result", toolName: "test", toolResult: "ok" });
    expect(out[1]).toEqual({ type: "run:tool_result", toolName: "test", toolResult: "boom", isError: true });
  });

  it("emits error+done(1) when agent_end carries errorMessage", async () => {
    const harness = makeCore([
      { type: "agent_end", messages: [{ role: "assistant", errorMessage: "kaboom", content: [], timestamp: 0 }] } as unknown as AgentEvent,
    ]);
    const runner = new BuiltinRunner(harness.core);
    const out = await collect(
      runner.run("task-err", {
        agentId: "test-agent", prompt: "p", cwd: "/tmp",
        builtin: { mode: "subagent", provider: fakeProvider(), tools: makeRegistry([]) },
      }, { abort: new AbortController().signal }),
    );
    expect(out).toEqual([
      { type: "run:error", error: "kaboom" },
      { type: "run:done", exitCode: 1 },
    ]);
  });

  it("clears the tool registry even if the agent throws", async () => {
    const setIds: string[] = [];
    const clearedIds: string[] = [];
    const errSession = {
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(async () => { throw new Error("boom"); }),
      abort: vi.fn(),
      dispose: vi.fn(),
      agent: { state: { systemPrompt: "" } },
    };
    const errCache = {
      createSession: vi.fn().mockResolvedValue(errSession),
    } as unknown as AgentServiceCache;
    const core = {
      setToolRegistry: (id: string) => setIds.push(id),
      clearToolRegistry: (id: string) => clearedIds.push(id),
      createServiceCache: () => errCache,
    } as unknown as PiMonoCore;
    const runner = new BuiltinRunner(core);

    const out = await collect(
      runner.run(
        "task-4",
        {
          agentId: "test-agent",
          prompt: "p",
          cwd: "/tmp",
          builtin: { mode: "subagent", provider: fakeProvider(), tools: makeRegistry([]) },
        },
        { abort: new AbortController().signal },
      ),
    );

    expect(out.some((e) => e.type === "run:error")).toBe(true);
    expect(out.at(-1)).toEqual({ type: "run:done", exitCode: 1 });
    expect(clearedIds).toEqual(setIds);
  });

  it("named mode: uses the provided cache+systemPrompt and skips setToolRegistry", async () => {
    const events: AgentEvent[] = [
      { type: "turn_start" } as AgentEvent,
      { type: "message_update", message: {} as never, assistantMessageEvent: { type: "text_delta", delta: "named-ok" } as never } as AgentEvent,
      { type: "turn_end", message: {} as never, toolResults: [] } as AgentEvent,
      { type: "agent_end", messages: [] } as AgentEvent,
    ];
    interface FakeNamedSession {
      _cb: ((event: { type: string }) => void) | null;
      subscribe: ReturnType<typeof vi.fn>;
      prompt: ReturnType<typeof vi.fn>;
      abort: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
      agent: { state: { systemPrompt: string } };
    }
    let capturedSystemPrompt: string | undefined;
    const namedSession: FakeNamedSession = {
      _cb: null,
      subscribe: vi.fn((cb: (event: { type: string }) => void) => {
        namedSession._cb = cb;
        return () => {};
      }),
      prompt: vi.fn(async () => {
        if (namedSession._cb) for (const e of events) namedSession._cb(e);
      }),
      abort: vi.fn(),
      dispose: vi.fn(),
      agent: { state: { systemPrompt: "" } },
    };
    const namedCache = {
      createSession: vi.fn().mockImplementation(async (opts: { systemPrompt: string }) => {
        capturedSystemPrompt = opts.systemPrompt;
        return namedSession;
      }),
    } as unknown as AgentServiceCache;

    const setIds: string[] = [];
    const clearedIds: string[] = [];
    let createdServiceCache = false;
    const core = {
      setToolRegistry: (id: string) => setIds.push(id),
      clearToolRegistry: (id: string) => clearedIds.push(id),
      createServiceCache: () => {
        createdServiceCache = true;
        return {} as unknown as AgentServiceCache;
      },
    } as unknown as PiMonoCore;
    const runner = new BuiltinRunner(core);

    const out = await collect(
      runner.run(
        "task-named",
        {
          agentId: "eous",
          prompt: "who are you?",
          cwd: "/eous-workspace",
          builtin: { mode: "named", cache: namedCache, systemPrompt: "I am eous." },
        },
        { abort: new AbortController().signal },
      ),
    );

    expect(capturedSystemPrompt).toBe("I am eous.");
    expect(setIds).toEqual([]);
    expect(clearedIds).toEqual([]);
    expect(createdServiceCache).toBe(false);
    expect(namedSession.dispose).toHaveBeenCalled();
    expect(out).toEqual([
      { type: "run:message", content: "named-ok" },
      { type: "run:done", exitCode: 0 },
    ]);
  });

  it("named mode: forwards abort signal to the underlying session", async () => {
    interface FakeNamedSession {
      _cb: ((event: { type: string }) => void) | null;
      subscribe: ReturnType<typeof vi.fn>;
      prompt: ReturnType<typeof vi.fn>;
      abort: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
      agent: { state: { systemPrompt: string } };
    }
    const namedSession: FakeNamedSession = {
      _cb: null,
      subscribe: vi.fn((cb: (event: { type: string }) => void) => {
        namedSession._cb = cb;
        return () => {};
      }),
      prompt: vi.fn(async () => {
        // Emit agent_end so bridgeSessionToRunEvents terminates
        if (namedSession._cb) namedSession._cb({ type: "agent_end", messages: [] } as never);
      }),
      abort: vi.fn(),
      dispose: vi.fn(),
      agent: { state: { systemPrompt: "" } },
    };
    const namedCache = {
      createSession: vi.fn().mockResolvedValue(namedSession),
    } as unknown as AgentServiceCache;
    const core = {
      setToolRegistry: vi.fn(),
      clearToolRegistry: vi.fn(),
      createServiceCache: vi.fn(),
    } as unknown as PiMonoCore;
    const runner = new BuiltinRunner(core);

    const ac = new AbortController();
    ac.abort();

    await collect(
      runner.run(
        "task-named-abort",
        {
          agentId: "eous",
          prompt: "p",
          cwd: "/eous-workspace",
          builtin: { mode: "named", cache: namedCache, systemPrompt: "I am eous." },
        },
        { abort: ac.signal },
      ),
    );

    expect(namedSession.abort).toHaveBeenCalled();
    expect(namedSession.dispose).toHaveBeenCalled();
  });
});
