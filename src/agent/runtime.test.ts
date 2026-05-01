import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  AgentRuntime,
  RESERVED_AGENT_IDS,
  LEAF_CONCURRENCY_CAP,
  SendMessageValidationError,
} from "./runtime.js";
import type { RegisteredAgent } from "./types.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function fakeAgent(id: string): RegisteredAgent {
  return {
    id,
    config: { id } as RegisteredAgent["config"],
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

function makeEvent(text: string): AgentEvent {
  return {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text }] } as never,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: text,
      partial: { role: "assistant", content: [{ type: "text", text }] } as never,
    } as never,
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
  run: (opts: {
    session: AgentSession;
    content: string;
    abort: AbortSignal;
  }) => AsyncGenerator<AgentEvent>;
}

function installStubRunner(rt: AgentRuntime, runner: StubPiRunner) {
  (rt as unknown as { piRunner: StubPiRunner }).piRunner = runner;
  (rt as unknown as { buildPiSession: () => Promise<AgentSession> }).buildPiSession =
    async () => ({ dispose: () => {}, abort: () => {} } as unknown as AgentSession);
}

async function consume(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ev of gen) { void _ev; }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("AgentRuntime — agent registry", () => {
  let rt: AgentRuntime;
  beforeEach(() => { rt = new AgentRuntime(); });

  it("registers and retrieves agents", () => {
    const a = fakeAgent("main");
    rt.registerAgent(a);
    expect(rt.getAgent("main")).toBe(a);
    expect(rt.listAgents()).toEqual([a]);
  });

  it("rejects duplicate registration", () => {
    rt.registerAgent(fakeAgent("main"));
    expect(() => rt.registerAgent(fakeAgent("main"))).toThrow(/already registered/);
  });

  it("rejects reserved magic ids", () => {
    for (const id of RESERVED_AGENT_IDS) {
      expect(() => rt.registerAgent(fakeAgent(id))).toThrow(/reserved magic id/);
    }
  });

  it("unregisters", () => {
    rt.registerAgent(fakeAgent("main"));
    expect(rt.unregisterAgent("main")).toBe(true);
    expect(rt.getAgent("main")).toBeUndefined();
    expect(rt.unregisterAgent("ghost")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("AgentRuntime.sendMessage — validation", () => {
  let rt: AgentRuntime;
  beforeEach(() => { rt = new AgentRuntime(); });

  it("rejects unknown agent id", async () => {
    await expect(consume(rt.sendMessage({ to: "ghost", content: "hi" }))).rejects.toThrow(/Unknown agent/);
  });

  it("rejects claude target when no claude runner is configured", async () => {
    await expect(consume(rt.sendMessage({ to: "claude", content: "hi", cwd: "/tmp" })))
      .rejects.toThrow(/claude runner not configured/);
  });

  it("rejects subagent target without leafContext", async () => {
    await expect(consume(rt.sendMessage({ to: "subagent", content: "hi" }))).rejects.toThrow(/leafContext is required/);
  });

  it("rejects sessionId on subagent target", async () => {
    await expect(consume(rt.sendMessage({
      to: "subagent",
      content: "hi",
      sessionId: "x",
      leafContext: {} as never,
    }))).rejects.toThrow(/leaf sessions are not resumable/);
  });

  it("rejects sendMessage when no pi runner configured", async () => {
    rt.registerAgent(fakeAgent("main"));
    await expect(consume(rt.sendMessage({ to: "main", content: "hi" }))).rejects.toThrow(/pi runner not configured/);
  });

  it("Unknown agent throws SendMessageValidationError", async () => {
    const gen = rt.sendMessage({ to: "ghost", content: "hi" });
    await expect(gen.next()).rejects.toBeInstanceOf(SendMessageValidationError);
  });

  it("subagent without leafContext throws SendMessageValidationError", async () => {
    const gen = rt.sendMessage({ to: "subagent", content: "hi" });
    await expect(gen.next()).rejects.toBeInstanceOf(SendMessageValidationError);
  });

  it("claude without runner throws SendMessageValidationError", async () => {
    const gen = rt.sendMessage({ to: "claude", content: "hi", cwd: "/tmp" });
    await expect(gen.next()).rejects.toBeInstanceOf(SendMessageValidationError);
  });
});

// ---------------------------------------------------------------------------
// Run tracking
// ---------------------------------------------------------------------------

describe("AgentRuntime — listRuns / getStatus", () => {
  it("returns empty before any run", () => {
    const rt = new AgentRuntime();
    expect(rt.listRuns()).toEqual([]);
    expect(rt.getStatus("any")).toBeUndefined();
  });
});

describe("AgentRuntime — leaf concurrency cap constant", () => {
  it("exports cap of 5", () => {
    expect(LEAF_CONCURRENCY_CAP).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// sendMessage flow — onRunStart timing
// ---------------------------------------------------------------------------

describe("runtime.sendMessage — onRunStart timing", () => {
  it("fires onRunStart before any AgentEvent is yielded", async () => {
    const rt = new AgentRuntime();
    const order: string[] = [];
    installStubRunner(rt, {
      async *run() {
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
      async *run() {
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
    expect(rt.listRuns()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// cancel — reason propagation
// ---------------------------------------------------------------------------

describe("runtime.cancel — reason propagates to onCancel", () => {
  it("user cancel → onCancel fires with reason", async () => {
    const rt = new AgentRuntime();
    const startedReady = new Promise<void>((resolve) => { (rt as unknown as { _ready: () => void })._ready = resolve; });
    let pendingResolve: () => void = () => {};
    const pending = new Promise<void>((r) => { pendingResolve = r; });

    installStubRunner(rt, {
      async *run(opts) {
        (rt as unknown as { _ready: () => void })._ready();
        opts.abort.addEventListener("abort", pendingResolve, { once: true });
        await pending;
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
      async *run(opts) {
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
    await new Promise((r) => setTimeout(r, 5));
    rt.cancel(runId!);
    await drain;

    expect(onCancel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Abort on consumer early-return
// ---------------------------------------------------------------------------

describe("runtime.sendMessage — abort on consumer early-return", () => {
  it("aborts the inner runner when caller breaks out of the for-await", async () => {
    const rt = new AgentRuntime();
    let abortObserved: boolean | undefined;
    let pendingResolve: () => void = () => {};
    const pending = new Promise<void>((r) => { pendingResolve = r; });

    installStubRunner(rt, {
      async *run(opts) {
        opts.abort.addEventListener("abort", () => { abortObserved = true; pendingResolve(); }, { once: true });
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
    expect(abortObserved).toBe(true);
    expect(rt.listRuns()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Per-session event subscription
// ---------------------------------------------------------------------------

describe("AgentRuntime session event subscription", () => {
  it("delivers events to a subscribed listener", () => {
    const rt = new AgentRuntime();
    const seen: AgentEvent[] = [];
    rt.on("s", (e) => seen.push(e));

    rt.emitSessionEvent("s", makeEvent("a"));
    rt.emitSessionEvent("s", makeEvent("b"));

    expect(seen).toHaveLength(2);
  });

  it("fans out to multiple listeners on the same session", () => {
    const rt = new AgentRuntime();
    const a: AgentEvent[] = [];
    const b: AgentEvent[] = [];
    rt.on("s", (e) => a.push(e));
    rt.on("s", (e) => b.push(e));

    rt.emitSessionEvent("s", makeEvent("hi"));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("returns an unsubscribe function that stops only that listener", () => {
    const rt = new AgentRuntime();
    const a: AgentEvent[] = [];
    const b: AgentEvent[] = [];
    const unsubA = rt.on("s", (e) => a.push(e));
    rt.on("s", (e) => b.push(e));

    rt.emitSessionEvent("s", makeEvent("1"));
    unsubA();
    rt.emitSessionEvent("s", makeEvent("2"));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  it("isolates a throwing listener so others still receive the event", () => {
    const rt = new AgentRuntime();
    const seen: AgentEvent[] = [];
    rt.on("s", () => { throw new Error("boom"); });
    rt.on("s", (e) => seen.push(e));

    expect(() => rt.emitSessionEvent("s", makeEvent("x"))).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("isolates events between sessions", () => {
    const rt = new AgentRuntime();
    const a: AgentEvent[] = [];
    const b: AgentEvent[] = [];
    rt.on("sessionA", (e) => a.push(e));
    rt.on("sessionB", (e) => b.push(e));

    rt.emitSessionEvent("sessionA", makeEvent("for-a"));
    rt.emitSessionEvent("sessionB", makeEvent("for-b"));
    rt.emitSessionEvent("sessionB", makeEvent("for-b-2"));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  it("emit on a session with no listeners is a no-op", () => {
    const rt = new AgentRuntime();
    expect(() => rt.emitSessionEvent("nobody-home", makeEvent("x"))).not.toThrow();
  });

  it("sessionListenerCount tracks adds and unsubs", () => {
    const rt = new AgentRuntime();
    expect(rt.sessionListenerCount("s")).toBe(0);

    const u1 = rt.on("s", () => {});
    const u2 = rt.on("s", () => {});
    expect(rt.sessionListenerCount("s")).toBe(2);

    u1();
    expect(rt.sessionListenerCount("s")).toBe(1);

    u2();
    expect(rt.sessionListenerCount("s")).toBe(0);
  });

  it("endSession removes all listeners and stops further delivery", () => {
    const rt = new AgentRuntime();
    const seen: AgentEvent[] = [];
    rt.on("s", (e) => seen.push(e));
    rt.on("s", (e) => seen.push(e));

    expect(rt.sessionListenerCount("s")).toBe(2);

    rt.endSession("s");
    expect(rt.sessionListenerCount("s")).toBe(0);

    rt.emitSessionEvent("s", makeEvent("after-end"));
    expect(seen).toHaveLength(0);
  });

  it("endSession on an unknown session is a no-op", () => {
    const rt = new AgentRuntime();
    expect(() => rt.endSession("never-existed")).not.toThrow();
  });

  it("logs and swallows listener errors (no crash propagation)", () => {
    const rt = new AgentRuntime();
    const errSpy = vi.fn();
    rt.on("s", () => { throw new Error("nope"); });
    rt.on("s", errSpy);

    rt.emitSessionEvent("s", makeEvent("x"));

    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});
