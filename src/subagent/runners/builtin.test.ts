// src/subagent/runners/builtin.test.ts — Tests for BuiltinRunner

import { describe, it, expect } from "vitest";
import type { AgentConfig, AgentEvent, AgentInstance, ProviderConfig } from "../../core/types.js";
import { ToolRegistry } from "../../core/tools.js";
import type { SubagentEvent } from "../types.js";
import { BuiltinRunner, type BuiltinAgentCore } from "./builtin.js";

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
  core: BuiltinAgentCore;
  setIds: string[];
  clearedIds: string[];
  capturedConfig: AgentConfig | undefined;
  abortCalled: number;
} {
  const setIds: string[] = [];
  const clearedIds: string[] = [];
  let capturedConfig: AgentConfig | undefined;
  let abortCalled = 0;

  const instance: AgentInstance = {
    async *[Symbol.asyncIterator]() {
      // unused
    },
    prompt: () =>
      (async function* () {
        for (const e of events) yield e;
      })(),
    abort: () => {
      abortCalled++;
    },
    steer: () => {},
    followUp: () => {},
  } as unknown as AgentInstance;

  const core: BuiltinAgentCore = {
    setToolRegistry: (id) => {
      setIds.push(id);
    },
    clearToolRegistry: (id) => {
      clearedIds.push(id);
    },
    createAgent: (config) => {
      capturedConfig = config;
      return instance;
    },
  };

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

async function collect(gen: AsyncGenerator<SubagentEvent>): Promise<SubagentEvent[]> {
  const out: SubagentEvent[] = [];
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
        { agent: "builtin", prompt: "hi", cwd: "/tmp" },
        { abort: new AbortController().signal },
      ),
    );
    expect(out[0].type).toBe("error");
    expect(out.at(-1)).toEqual({ type: "done", exitCode: 1 });
  });

  it("registers a filtered tool registry, runs, and clears it", async () => {
    const harness = makeCore([
      { type: "turn_start" },
      { type: "text_delta", text: "ok" },
      { type: "turn_end" },
      { type: "agent_end", messages: [] },
    ]);
    const runner = new BuiltinRunner(harness.core);
    const tools = makeRegistry(["read_file", "write_file", "shell"]);

    const out = await collect(
      runner.run(
        "task-2",
        {
          agent: "builtin",
          prompt: "do thing",
          cwd: "/tmp",
          builtin: { provider: fakeProvider(), tools },
        },
        { abort: new AbortController().signal },
      ),
    );

    expect(harness.setIds).toHaveLength(1);
    expect(harness.setIds[0]).toMatch(/^subagent-builtin-task-2-/);
    expect(harness.clearedIds).toEqual(harness.setIds);

    expect(harness.capturedConfig?.systemPrompt).toContain("do thing");
    expect(harness.capturedConfig?.compaction).toEqual({ mode: "off" });
    expect(harness.capturedConfig?.provider?.type).toBe("anthropic");

    expect(out).toEqual([
      { type: "message", content: "ok" },
      { type: "done", exitCode: 0 },
    ]);
  });

  it("aborts the underlying instance when the abort signal fires", async () => {
    const harness = makeCore([
      { type: "turn_start" },
      { type: "agent_end", messages: [] },
    ]);
    const runner = new BuiltinRunner(harness.core);
    const ac = new AbortController();
    ac.abort();

    await collect(
      runner.run(
        "task-3",
        {
          agent: "builtin",
          prompt: "p",
          cwd: "/tmp",
          builtin: { provider: fakeProvider(), tools: makeRegistry([]) },
        },
        { abort: ac.signal },
      ),
    );

    expect(harness.abortCalled).toBeGreaterThanOrEqual(1);
  });

  it("clears the tool registry even if the agent throws", async () => {
    const setIds: string[] = [];
    const clearedIds: string[] = [];
    const errInstance: AgentInstance = {
      prompt: () =>
        (async function* () {
          throw new Error("boom");
          yield undefined as never;
        })(),
      abort: () => {},
      steer: () => {},
      followUp: () => {},
    } as unknown as AgentInstance;
    const core: BuiltinAgentCore = {
      setToolRegistry: (id) => setIds.push(id),
      clearToolRegistry: (id) => clearedIds.push(id),
      createAgent: () => errInstance,
    };
    const runner = new BuiltinRunner(core);

    await expect(
      collect(
        runner.run(
          "task-4",
          {
            agent: "builtin",
            prompt: "p",
            cwd: "/tmp",
            builtin: { provider: fakeProvider(), tools: makeRegistry([]) },
          },
          { abort: new AbortController().signal },
        ),
      ),
    ).rejects.toThrow("boom");

    expect(clearedIds).toEqual(setIds);
  });
});
