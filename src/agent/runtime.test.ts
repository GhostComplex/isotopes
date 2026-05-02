import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  AgentRuntime,
  MAX_DEPTH,
  MAX_CHILDREN_PER_PARENT,
  type Runner,
} from "./runtime.js";
import type { RegisteredAgent } from "./types.js";
import { RunValidationError } from "./types.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";

function fakeAgent(id: string): RegisteredAgent {
  return {
    id,
    config: { id } as RegisteredAgent["config"],
    sessionStore: {} as RegisteredAgent["sessionStore"],
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

/** Minimal Runner stub for dispatch-level tests. Override per test. */
function stubRunner(opts: Omit<Partial<Runner>, "agent"> & { agent?: RegisteredAgent } = {}): Runner {
  const { agent, ...overrides } = opts;
  const base: Runner = {
    resolveSessionId: (_req, runId) => `stub:${runId}`,
    async *run() {},
    ...overrides,
  };
  if (agent) base.agent = () => agent;
  return base;
}

async function consume(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ev of gen) { void _ev; }
}

describe("AgentRuntime — agent registry", () => {
  let rt: AgentRuntime;
  beforeEach(() => { rt = new AgentRuntime(); });

  it("registerRunner with agent metadata is reachable via getAgent / listAgents", () => {
    const a = fakeAgent("main");
    rt.registerRunner("main", stubRunner({ agent: a }));
    expect(rt.getAgent("main")).toBe(a);
    expect(rt.listAgents()).toEqual([a]);
  });

  it("registerRunner without agent metadata is invisible to getAgent", () => {
    rt.registerRunner("worker", stubRunner());
    expect(rt.getAgent("worker")).toBeUndefined();
    expect(rt.listAgents()).toEqual([]);
  });

  it("rejects duplicate registration under the same name", () => {
    rt.registerRunner("main", stubRunner({ agent: fakeAgent("main") }));
    expect(() => rt.registerRunner("main", stubRunner())).toThrow(/Already registered/);
  });

  it("unregisterAgent removes the entry and tools", () => {
    rt.registerRunner("main", stubRunner({ agent: fakeAgent("main") }));
    expect(rt.unregisterAgent("main")).toBe(true);
    expect(rt.getAgent("main")).toBeUndefined();
    expect(rt.unregisterAgent("ghost")).toBe(false);
  });
});

describe("AgentRuntime.run — validation", () => {
  let rt: AgentRuntime;
  beforeEach(() => {
    rt = new AgentRuntime();
    // Stub a runner that rejects sessionId (mimics subagent / claude).
    rt.registerRunner("ephemeral-only", {
      resolveSessionId: (_req, runId) => `ephemeral:${runId}`,
      validateRequest(req) {
        if (req.sessionId) throw new RunValidationError("ephemeral-only: sessions are not resumable; omit sessionId");
      },
      async *run() {},
    });
  });

  it("rejects unknown agent id", async () => {
    await expect(consume(rt.run({ to: "ghost", content: "hi" }))).rejects.toThrow(/Unknown agent/);
  });

  it("rejects sessionId on a runner that doesn't support resume", async () => {
    await expect(consume(rt.run({
      to: "ephemeral-only",
      content: "hi",
      sessionId: "x",
    }))).rejects.toThrow(/sessions are not resumable/);
  });

  it("Unknown agent throws RunValidationError", async () => {
    const gen = rt.run({ to: "ghost", content: "hi" });
    await expect(gen.next()).rejects.toBeInstanceOf(RunValidationError);
  });

});

describe("AgentRuntime.run — depth + sibling limits", () => {
  it("rejects when spawn-tree depth would exceed MAX_DEPTH", async () => {
    const rt = new AgentRuntime();
    // Stub a runner that does nothing — we drive depth via parentSessionId.
    rt.registerRunner("worker", stubRunner({
      resolveSessionId: (_req) => "stub-session-1",
    }));
    // Manually plant a deep parent chain by injecting a fake run handle at depth = MAX_DEPTH.
    (rt as unknown as { runs: Map<string, { sessionId: string; depth: number; parentSessionId?: string }> }).runs.set("fake", {
      sessionId: "deep-parent",
      depth: MAX_DEPTH,
    });
    await expect(consume(rt.run({
      to: "worker",
      content: "hi",
      parentSessionId: "deep-parent",
    }))).rejects.toThrow(/Max spawn depth reached/);
  });

  it("rejects when sibling count would exceed MAX_CHILDREN_PER_PARENT", async () => {
    const rt = new AgentRuntime();
    rt.registerRunner("worker", stubRunner());
    const runs = (rt as unknown as { runs: Map<string, { sessionId: string; depth: number; parentSessionId?: string }> }).runs;
    // Plant MAX_CHILDREN_PER_PARENT siblings sharing the same parentSessionId.
    for (let i = 0; i < MAX_CHILDREN_PER_PARENT; i++) {
      runs.set(`sib-${i}`, { sessionId: `sib-${i}`, depth: 2, parentSessionId: "shared-parent" });
    }
    await expect(consume(rt.run({
      to: "worker",
      content: "hi",
      parentSessionId: "shared-parent",
    }))).rejects.toThrow(/Max concurrent children/);
  });

  it("top-level run lands at depth 1", async () => {
    const rt = new AgentRuntime();
    let observedDepth: number | undefined;
    rt.registerRunner("worker", stubRunner({
      async *run() {
        observedDepth = rt.listRuns()[0]?.depth;
        yield buildAgentEnd("done");
      },
    }));
    for await (const _ of rt.run({ to: "worker", content: "hi" })) { void _; }
    expect(observedDepth).toBe(1);
  });

  it("nested run inherits parent.depth + 1", async () => {
    const rt = new AgentRuntime();
    // Fake a parent run sitting at depth 2 with sessionId "parent-1".
    (rt as unknown as { runs: Map<string, { sessionId: string; depth: number }> }).runs.set("parent-run", {
      sessionId: "parent-1",
      depth: 2,
    });
    let observedDepth: number | undefined;
    rt.registerRunner("worker", stubRunner({
      async *run() {
        // Find the new run by agentId (planted parent has no agentId).
        observedDepth = rt.listRuns().find((r) => r.agentId === "worker")?.depth;
        yield buildAgentEnd("done");
      },
    }));
    for await (const _ of rt.run({
      to: "worker",
      content: "hi",
      parentSessionId: "parent-1",
    })) { void _; }
    expect(observedDepth).toBe(3);
  });
});

describe("AgentRuntime — listRuns / getStatus", () => {
  it("returns empty before any run", () => {
    const rt = new AgentRuntime();
    expect(rt.listRuns()).toEqual([]);
    expect(rt.getStatus("any")).toBeUndefined();
  });
});

describe("AgentRuntime — depth/breadth limit constants", () => {
  it("MAX_DEPTH = 5, MAX_CHILDREN_PER_PARENT = 5", () => {
    expect(MAX_DEPTH).toBe(5);
    expect(MAX_CHILDREN_PER_PARENT).toBe(5);
  });
});

describe("runtime.run — onRunStart timing", () => {
  it("fires onRunStart before any AgentEvent is yielded", async () => {
    const rt = new AgentRuntime();
    const order: string[] = [];
    rt.registerRunner("main", stubRunner({
      async *run() {
        order.push("event:start");
        yield buildAgentEnd("done");
      },
      agent: fakeAgent("main"),
    }));

    const events: AgentEvent[] = [];
    for await (const ev of rt.run({
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
    rt.registerRunner("main", stubRunner({
      async *run() {
        runIdsDuringRun = rt.listRuns().map((r) => r.runId);
        yield buildAgentEnd("ok");
      },
      agent: fakeAgent("main"),
    }));

    for await (const _ev of rt.run({
      to: "main",
      content: "hi",
      onRunStart: (rid) => { observedRunId = rid; },
    })) { void _ev; }

    expect(observedRunId).toBeDefined();
    expect(runIdsDuringRun).toContain(observedRunId!);
    expect(rt.listRuns()).toEqual([]);
  });
});

describe("runtime.cancel — reason propagates to onCancel", () => {
  it("user cancel → onCancel fires with reason", async () => {
    const rt = new AgentRuntime();
    let pendingResolve: () => void = () => {};
    const pending = new Promise<void>((r) => { pendingResolve = r; });
    let runStarted: () => void = () => {};
    const started = new Promise<void>((r) => { runStarted = r; });

    rt.registerRunner("main", stubRunner({
      async *run(opts) {
        runStarted();
        opts.abort.addEventListener("abort", pendingResolve, { once: true });
        await pending;
        yield buildAgentEnd("aborted", "stop");
      },
      agent: fakeAgent("main"),
    }));

    const onCancel = vi.fn();
    let runId: string | undefined;
    const stream = rt.run({
      to: "main",
      content: "long",
      onRunStart: (rid) => { runId = rid; },
      onCancel,
    });

    const drain = (async () => { for await (const _ev of stream) { void _ev; } })();

    await started;
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

    rt.registerRunner("main", stubRunner({
      async *run(opts) {
        opts.abort.addEventListener("abort", pendingResolve, { once: true });
        await pending;
        yield buildAgentEnd("done");
      },
      agent: fakeAgent("main"),
    }));

    const onCancel = vi.fn();
    let runId: string | undefined;
    const stream = rt.run({
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

describe("runtime.run — abort on consumer early-return", () => {
  it("aborts the inner runner when caller breaks out of the for-await", async () => {
    const rt = new AgentRuntime();
    let abortObserved: boolean | undefined;
    let pendingResolve: () => void = () => {};
    const pending = new Promise<void>((r) => { pendingResolve = r; });

    rt.registerRunner("main", stubRunner({
      async *run(opts) {
        opts.abort.addEventListener("abort", () => { abortObserved = true; pendingResolve(); }, { once: true });
        yield { type: "turn_start" } as AgentEvent;
        await pending;
        yield buildAgentEnd("late");
      },
      agent: fakeAgent("main"),
    }));

    let count = 0;
    for await (const ev of rt.run({ to: "main", content: "hi" })) {
      void ev;
      count++;
      if (count === 1) break;
    }
    expect(abortObserved).toBe(true);
    expect(rt.listRuns()).toEqual([]);
  });
});

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
