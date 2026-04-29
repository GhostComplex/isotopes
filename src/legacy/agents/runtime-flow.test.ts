// Flow tests for AgentRuntime.sendMessage. Stubs PiRunner via
// private-field replacement to assert orchestration (onRunStart timing,
// cancel-reason propagation, abort-on-break, validation error class).

import { describe, it, expect, vi } from "vitest";
import { AgentRuntime, SendMessageValidationError } from "./runtime.js";
import type { RegisteredAgent } from "./types.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

function fakeAgent(id: string): RegisteredAgent {
  return {
    id,
    config: { id } as RegisteredAgent["config"],
    systemPrompt: "you are " + id,
    sessionStore: {
      findByKey: vi.fn(async () => undefined),
      create: vi.fn(async (_aid: string, opts?: { key?: string }) => ({
        id: opts?.key ?? "stub-session",
        agentId: _aid,
        lastActiveAt: new Date(),
      })),
    } as unknown as RegisteredAgent["sessionStore"],
    capabilities: { tools: [], canBeAddressed: true },
  };
}

function buildAgentEnd(text: string, stopReason = "end", errorMessage?: string): AgentEvent {
  return {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason,
        ...(errorMessage ? { errorMessage } : {}),
      },
    ] as never,
  };
}

interface StubPiRunner {
  sendMessage: (opts: {
    runId: string;
    abort: AbortSignal;
    onSessionReady?: (s: AgentSession) => void;
  }) => AsyncGenerator<AgentEvent>;
}

function installStubRunner(rt: AgentRuntime, runner: StubPiRunner) {
  (rt as unknown as { piRunner: StubPiRunner }).piRunner = runner;
}

describe("runtime.sendMessage — onRunStart timing", () => {
  it("fires onRunStart before any AgentEvent is yielded", async () => {
    const rt = new AgentRuntime();
    const order: string[] = [];
    installStubRunner(rt, {
      async *sendMessage() {
        order.push("event:start");
        yield buildAgentEnd("done");
      },
    });
    rt.registerAgent(fakeAgent("main"));

    const events: AgentEvent[] = [];
    for await (const ev of rt.sendMessage({
      to: "main",
      content: "hi",
      onRunStart: (rid) => order.push(`onRunStart:${rid.slice(0, 4)}`),
    })) {
      events.push(ev);
    }
    expect(order[0]).toMatch(/^onRunStart:/);
    expect(order[1]).toBe("event:start");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("agent_end");
  });

  it("onRunStart sees a runId that listRuns also reports during the run", async () => {
    const rt = new AgentRuntime();
    let observedRunId: string | undefined;
    let runIdsDuringRun: string[] = [];
    installStubRunner(rt, {
      async *sendMessage() {
        runIdsDuringRun = rt.listRuns().map((r) => r.runId);
        yield buildAgentEnd("ok");
      },
    });
    rt.registerAgent(fakeAgent("main"));

    for await (const _ev of rt.sendMessage({
      to: "main",
      content: "hi",
      onRunStart: (rid) => { observedRunId = rid; },
    })) { void _ev; }

    expect(observedRunId).toBeDefined();
    expect(runIdsDuringRun).toContain(observedRunId!);
    // Run is cleaned up after iteration.
    expect(rt.listRuns()).toEqual([]);
  });
});

describe("runtime.cancel — reason propagates to onCancel", () => {
  it("user cancel → onCancel fires with reason", async () => {
    const rt = new AgentRuntime();
    const startedReady = new Promise<void>((resolve) => { (rt as unknown as { _ready: () => void })._ready = resolve; });
    let pendingResolve: () => void = () => {};
    const pending = new Promise<void>((r) => { pendingResolve = r; });

    installStubRunner(rt, {
      async *sendMessage(opts) {
        (rt as unknown as { _ready: () => void })._ready();
        opts.abort.addEventListener("abort", pendingResolve, { once: true });
        await pending;
        // After abort, end gracefully.
        yield buildAgentEnd("aborted", "stop");
      },
    });
    rt.registerAgent(fakeAgent("main"));

    const onCancel = vi.fn();
    let runId: string | undefined;
    const stream = rt.sendMessage({
      to: "main",
      content: "long",
      onRunStart: (rid) => { runId = rid; },
      onCancel,
    });

    const drain = (async () => {
      for await (const _ev of stream) { void _ev; }
    })();

    await startedReady;
    expect(runId).toBeDefined();
    rt.cancel(runId!, { reason: "user" });
    await drain;

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith("user");
  });

  it("cancel without reason still aborts but does not fire onCancel", async () => {
    const rt = new AgentRuntime();
    let pendingResolve: () => void = () => {};
    const pending = new Promise<void>((r) => { pendingResolve = r; });

    installStubRunner(rt, {
      async *sendMessage(opts) {
        opts.abort.addEventListener("abort", pendingResolve, { once: true });
        await pending;
        yield buildAgentEnd("done");
      },
    });
    rt.registerAgent(fakeAgent("main"));

    const onCancel = vi.fn();
    let runId: string | undefined;
    const stream = rt.sendMessage({
      to: "main",
      content: "x",
      onRunStart: (rid) => { runId = rid; },
      onCancel,
    });

    const drain = (async () => { for await (const _ of stream) { void _; } })();
    // Wait a tick so onRunStart fires.
    await new Promise((r) => setTimeout(r, 5));
    rt.cancel(runId!); // no reason
    await drain;

    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("runtime.sendMessage — abort on consumer early-return", () => {
  it("aborts the inner runner when caller breaks out of the for-await", async () => {
    const rt = new AgentRuntime();
    let abortObserved: boolean | undefined;
    let pendingResolve: () => void = () => {};
    const pending = new Promise<void>((r) => { pendingResolve = r; });

    installStubRunner(rt, {
      async *sendMessage(opts) {
        opts.abort.addEventListener("abort", () => { abortObserved = true; pendingResolve(); }, { once: true });
        // Yield one event so the consumer can break, then await abort.
        yield { type: "turn_start" } as AgentEvent;
        await pending;
        yield buildAgentEnd("late");
      },
    });
    rt.registerAgent(fakeAgent("main"));

    let count = 0;
    for await (const ev of rt.sendMessage({ to: "main", content: "hi" })) {
      void ev;
      count++;
      if (count === 1) break;
    }
    // The finally block should have aborted before resolving.
    expect(abortObserved).toBe(true);
    expect(rt.listRuns()).toEqual([]);
  });
});

describe("runtime.sendMessage — validation errors are typed", () => {
  it("Unknown agent throws SendMessageValidationError", async () => {
    const rt = new AgentRuntime();
    const gen = rt.sendMessage({ to: "ghost", content: "hi" });
    await expect(gen.next()).rejects.toBeInstanceOf(SendMessageValidationError);
  });

  it("subagent without leafContext throws SendMessageValidationError", async () => {
    const rt = new AgentRuntime();
    const gen = rt.sendMessage({ to: "subagent", content: "hi" });
    await expect(gen.next()).rejects.toBeInstanceOf(SendMessageValidationError);
  });

  it("claude without runner throws SendMessageValidationError", async () => {
    const rt = new AgentRuntime();
    const gen = rt.sendMessage({ to: "claude", content: "hi", cwd: "/tmp" });
    await expect(gen.next()).rejects.toBeInstanceOf(SendMessageValidationError);
  });
});
