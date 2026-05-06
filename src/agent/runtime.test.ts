import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
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
    resolveSessionId: (req) => req.sessionId ?? `stub:${randomUUID()}`,
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
      resolveSessionId: () => `ephemeral:${randomUUID()}`,
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

describe("AgentRuntime — listRuns / getRunBySession", () => {
  it("returns empty before any run", () => {
    const rt = new AgentRuntime();
    expect(rt.listRuns()).toEqual([]);
    expect(rt.getRunBySession("any")).toBeUndefined();
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
      onRunStart: (sid) => order.push(`onRunStart:${sid.slice(0, 4)}`),
    })) {
      events.push(ev);
    }
    expect(order[0]).toMatch(/^onRunStart:/);
    expect(order[1]).toBe("event:start");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("agent_end");
  });

  it("onRunStart sees a sessionId that listRuns also reports during the run", async () => {
    const rt = new AgentRuntime();
    let observedSessionId: string | undefined;
    let sessionIdsDuringRun: string[] = [];
    rt.registerRunner("main", stubRunner({
      async *run() {
        sessionIdsDuringRun = rt.listRuns().map((r) => r.sessionId);
        yield buildAgentEnd("ok");
      },
      agent: fakeAgent("main"),
    }));

    for await (const _ev of rt.run({
      to: "main",
      content: "hi",
      onRunStart: (sid) => { observedSessionId = sid; },
    })) { void _ev; }

    expect(observedSessionId).toBeDefined();
    expect(sessionIdsDuringRun).toContain(observedSessionId!);
    expect(rt.listRuns()).toEqual([]);
  });

  it("onRunStart receives sessionId so callers can dispatch by session", async () => {
    const rt = new AgentRuntime();
    let observedSessionId: string | undefined;
    rt.registerRunner("main", stubRunner({
      async *run() { yield buildAgentEnd("done"); },
      agent: fakeAgent("main"),
    }));

    for await (const _ev of rt.run({
      to: "main",
      sessionId: "explicit-session",
      content: "hi",
      onRunStart: (sid) => { observedSessionId = sid; },
    })) { void _ev; }

    expect(observedSessionId).toBe("explicit-session");
    // Critical for discord /stop in sub-run thread: caller registers
    // (threadId → sessionId) using the sessionId from onRunStart so
    // runtime.cancel(sessionId) routes correctly.
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
    const stream = rt.run({
      to: "main",
      sessionId: "cancel-1",
      content: "long",
      onCancel,
    });

    const drain = (async () => { for await (const _ev of stream) { void _ev; } })();

    await started;
    rt.cancel("cancel-1", { reason: "user" });
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
    const stream = rt.run({
      to: "main",
      sessionId: "cancel-2",
      content: "x",
      onCancel,
    });

    const drain = (async () => { for await (const _ of stream) { void _; } })();
    await new Promise((r) => setTimeout(r, 5));
    rt.cancel("cancel-2");
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

describe("runtime.steer — wires onSession into RunHandle", () => {
  it("steer reaches the runner's session via onSession callback", async () => {
    const rt = new AgentRuntime();
    const steerSpy = vi.fn();
    let pendingResolve: () => void = () => {};
    const pending = new Promise<void>((r) => { pendingResolve = r; });
    let runStarted: () => void = () => {};
    const started = new Promise<void>((r) => { runStarted = r; });

    rt.registerRunner("main", stubRunner({
      async *run(opts) {
        opts.onSession?.({ steer: steerSpy } as never);
        runStarted();
        opts.abort.addEventListener("abort", pendingResolve, { once: true });
        await pending;
        yield buildAgentEnd("done");
      },
      agent: fakeAgent("main"),
    }));

    const stream = rt.run({
      to: "main",
      sessionId: "steer-1",
      content: "hi",
    });
    const drain = (async () => { for await (const _ev of stream) { void _ev; } })();

    await started;
    await rt.steer("steer-1", "interject");
    expect(steerSpy).toHaveBeenCalledWith("interject");

    rt.cancel("steer-1");
    await drain;
  });

  it("steer throws when runner did not call onSession", async () => {
    const rt = new AgentRuntime();
    let pendingResolve: () => void = () => {};
    const pending = new Promise<void>((r) => { pendingResolve = r; });
    let runStarted: () => void = () => {};
    const started = new Promise<void>((r) => { runStarted = r; });

    rt.registerRunner("noSteer", stubRunner({
      async *run(opts) {
        runStarted();
        opts.abort.addEventListener("abort", pendingResolve, { once: true });
        await pending;
        yield buildAgentEnd("done");
      },
      agent: fakeAgent("noSteer"),
    }));

    const stream = rt.run({
      to: "noSteer",
      sessionId: "steer-2",
      content: "hi",
    });
    const drain = (async () => { for await (const _ev of stream) { void _ev; } })();

    await started;
    await expect(rt.steer("steer-2", "x")).rejects.toThrow(/No active session/);

    rt.cancel("steer-2");
    await drain;
  });
});

describe("AgentRuntime no longer exposes a per-session event bus", () => {
  it("removed runtime.on/emitSessionEvent/endSession/sessionListenerCount", () => {
    const rt = new AgentRuntime();
    expect((rt as unknown as { on?: unknown }).on).toBeUndefined();
    expect((rt as unknown as { emitSessionEvent?: unknown }).emitSessionEvent).toBeUndefined();
    expect((rt as unknown as { endSession?: unknown }).endSession).toBeUndefined();
    expect((rt as unknown as { sessionListenerCount?: unknown }).sessionListenerCount).toBeUndefined();
  });
});

describe("AgentRuntime.shutdown", () => {
  it("is a no-op when no sandboxBaseConfig was passed", async () => {
    const rt = new AgentRuntime();
    await expect(rt.shutdown()).resolves.toBeUndefined();
  });

  it("is idempotent — calling twice does not throw", async () => {
    const rt = new AgentRuntime();
    await rt.shutdown();
    await expect(rt.shutdown()).resolves.toBeUndefined();
  });

  it("calls cleanup on the SandboxExecutor exactly once across repeated shutdowns", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const rt = new AgentRuntime();
    (rt as unknown as { sandboxExecutor: { cleanup: () => Promise<void> } }).sandboxExecutor = { cleanup };
    await rt.shutdown();
    await rt.shutdown();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
