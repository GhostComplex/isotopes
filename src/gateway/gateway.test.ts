import { describe, it, expect, vi } from "vitest";
import { createGateway } from "./gateway.js";
import { AgentRuntime, type Runner } from "../agent/runtime.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { Message } from "./types.js";

let nextSessionId = 0;

function makeStores() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stores = new Map<string, any>();
  return {
    async getOrCreate(agentId: string) {
      let s = stores.get(agentId);
      if (s) return s;
      const sessions = new Map();
      const byKey = new Map<string, string>();
      s = {
        async create(aid: string, metadata?: { key?: string }) {
          const id = `sess-${++nextSessionId}`;
          const session = { id, agentId: aid, metadata, lastActiveAt: new Date() };
          sessions.set(id, session);
          if (metadata?.key) byKey.set(metadata.key, id);
          return session;
        },
        async findByKey(key: string) {
          const id = byKey.get(key);
          return id ? sessions.get(id) : undefined;
        },
      };
      stores.set(agentId, s);
      return s;
    },
  } as never;
}

function textDelta(delta: string): AgentEvent {
  return {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: delta }] } as never,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta,
      partial: { role: "assistant", content: [{ type: "text", text: delta }] } as never,
    } as never,
  };
}

function agentEnd(text = "ok", stopReason: string = "end", errorMessage?: string): AgentEvent {
  return {
    type: "agent_end",
    messages: [{
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
      ...(errorMessage ? { errorMessage } : {}),
    }] as never,
  };
}

function fastRunner(deltas: string[], stopReason: string = "end", errorMessage?: string): Runner {
  return {
    resolveSessionId: (req) => req.sessionId ?? "stub",
    async *run() {
      for (const d of deltas) yield textDelta(d);
      yield agentEnd(deltas.join(""), stopReason, errorMessage);
    },
  };
}

function buildRuntime(runner: Runner) {
  const rt = new AgentRuntime();
  rt.registerRunner("main", runner);
  return rt;
}

const baseMsg: Message = { agentId: "main", content: "hi", source: "tui" };

describe("gateway.dispatch (started)", () => {
  it("returns started + accumulates responseText", async () => {
    const runtime = buildRuntime(fastRunner(["hel", "lo, ", "world"]));
    const gateway = createGateway({ agentRuntime: runtime, sessionStoreManager: makeStores() });

    const result = await gateway.dispatch(baseMsg);
    expect(result.state).toBe("started");
    expect(result.responseText).toBe("hello, world");
    expect(result.errorMessage).toBeNull();
    expect(result.sessionId).toMatch(/^sess-/);
  });

  it("invokes onTextDelta + onToolStart/End callbacks", async () => {
    const toolEvent: AgentEvent = {
      type: "tool_execution_start", toolCallId: "t1", toolName: "echo", args: { x: 1 },
    };
    const toolEnd: AgentEvent = {
      type: "tool_execution_end", toolCallId: "t1", toolName: "echo", result: "done", isError: false,
    };
    const runner: Runner = {
      resolveSessionId: (req) => req.sessionId ?? "stub",
      async *run() {
        yield textDelta("a");
        yield toolEvent;
        yield toolEnd;
        yield textDelta("b");
        yield agentEnd("ab");
      },
    };
    const runtime = buildRuntime(runner);
    const gateway = createGateway({ agentRuntime: runtime, sessionStoreManager: makeStores() });

    const onTextDelta = vi.fn();
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();
    await gateway.dispatch(baseMsg, { onTextDelta, onToolStart, onToolEnd });

    expect(onTextDelta).toHaveBeenCalledWith("a");
    expect(onTextDelta).toHaveBeenCalledWith("b");
    expect(onToolStart).toHaveBeenCalledWith({ id: "t1", name: "echo", args: { x: 1 } });
    expect(onToolEnd).toHaveBeenCalledWith({ id: "t1", name: "echo", result: "done", isError: false });
  });

  it("captures errorMessage from agent_end", async () => {
    const runtime = buildRuntime(fastRunner(["x"], "error", "boom"));
    const gateway = createGateway({ agentRuntime: runtime, sessionStoreManager: makeStores() });

    const result = await gateway.dispatch(baseMsg);
    expect(result.errorMessage).toBe("boom");
  });
});

describe("gateway.dispatch (queued)", () => {
  it("forwards to runtime.steer when session is busy", async () => {
    const longRunner: Runner = {
      resolveSessionId: (req) => req.sessionId ?? "stub",
      async *run({ abort }) {
        yield textDelta("running");
        await new Promise((r) => abort.addEventListener("abort", r, { once: true }));
        yield agentEnd();
      },
    };
    const runtime = buildRuntime(longRunner);
    const steerSpy = vi.spyOn(runtime, "steer").mockResolvedValue();
    const gateway = createGateway({ agentRuntime: runtime, sessionStoreManager: makeStores() });

    const first = gateway.dispatch({ ...baseMsg, sessionKey: "shared", content: "first" });
    const second = await gateway.dispatch({ ...baseMsg, sessionKey: "shared", content: "second" });
    expect(second.state).toBe("queued");
    expect(second.sessionId).toMatch(/^sess-/);
    expect(steerSpy).toHaveBeenCalledWith(second.sessionId, "second");

    await gateway.abort(second.sessionId);
    await first;
  });

  it("steer awaits run readiness (no race against runner registration)", async () => {
    let runnerStarted = false;
    let steerCalledBeforeRunReady = false;
    const slowStartRunner: Runner = {
      resolveSessionId: (req) => req.sessionId ?? "stub",
      async *run({ abort }) {
        // Simulate runner doing async setup before pi registers the run.
        await new Promise((r) => setTimeout(r, 20));
        runnerStarted = true;
        yield textDelta("ready");
        await new Promise((r) => abort.addEventListener("abort", r, { once: true }));
        yield agentEnd();
      },
    };
    const runtime = buildRuntime(slowStartRunner);
    vi.spyOn(runtime, "steer").mockImplementation(async () => {
      if (!runnerStarted) steerCalledBeforeRunReady = true;
    });
    const gateway = createGateway({ agentRuntime: runtime, sessionStoreManager: makeStores() });

    const first = gateway.dispatch({ ...baseMsg, sessionKey: "race", content: "a" });
    const second = await gateway.dispatch({ ...baseMsg, sessionKey: "race", content: "b" });

    expect(second.state).toBe("queued");
    expect(steerCalledBeforeRunReady).toBe(false);

    await gateway.abort(second.sessionId);
    await first;
  });

  it("dedupes concurrent resolveSessionId calls for the same sessionKey", async () => {
    const longRunner: Runner = {
      resolveSessionId: (req) => req.sessionId ?? "stub",
      async *run({ abort }) {
        yield textDelta("running");
        await new Promise((r) => abort.addEventListener("abort", r, { once: true }));
        yield agentEnd();
      },
    };
    const runtime = buildRuntime(longRunner);
    vi.spyOn(runtime, "steer").mockResolvedValue();
    const stores = makeStores();
    const createSpy = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = stores as any;
    const origGetOrCreate = s.getOrCreate.bind(s);
    s.getOrCreate = async (agentId: string) => {
      const store = await origGetOrCreate(agentId);
      const origCreate = store.create.bind(store);
      store.create = async (aid: string, metadata?: { key?: string }) => {
        createSpy(aid, metadata?.key);
        return origCreate(aid, metadata);
      };
      return store;
    };
    const gateway = createGateway({ agentRuntime: runtime, sessionStoreManager: stores });

    const first = gateway.dispatch({ ...baseMsg, sessionKey: "dup", content: "a" });
    const second = await gateway.dispatch({ ...baseMsg, sessionKey: "dup", content: "b" });

    expect(second.sessionId).toBeDefined();
    expect(createSpy).toHaveBeenCalledTimes(1);

    await gateway.abort(second.sessionId);
    const firstResult = await first;
    expect(firstResult.sessionId).toBe(second.sessionId);
  });

  it("falls through to a fresh run if the prior run ended between observe and steer", async () => {
    // First run completes immediately. Second dispatch grabs a stale handle
    // (active still set from the just-finished run could in theory be observed
    // before the finally-delete; we simulate by serializing dispatches across
    // a completed first run). The second dispatch must start a fresh run, not
    // attempt to steer into the dead one.
    const runtime = buildRuntime(fastRunner(["one"]));
    const steerSpy = vi.spyOn(runtime, "steer");
    const gateway = createGateway({ agentRuntime: runtime, sessionStoreManager: makeStores() });

    const first = await gateway.dispatch({ ...baseMsg, sessionKey: "ended", content: "first" });
    expect(first.state).toBe("started");

    const second = await gateway.dispatch({ ...baseMsg, sessionKey: "ended", content: "second" });
    expect(second.state).toBe("started");
    expect(second.responseText).toBe("one");
    expect(steerSpy).not.toHaveBeenCalled();
  });

  it("surfaces non-race steer failures via errorMessage (not silent null)", async () => {
    const longRunner: Runner = {
      resolveSessionId: (req) => req.sessionId ?? "stub",
      async *run({ abort }) {
        yield textDelta("running");
        await new Promise((r) => abort.addEventListener("abort", r, { once: true }));
        yield agentEnd();
      },
    };
    const runtime = buildRuntime(longRunner);
    vi.spyOn(runtime, "steer").mockRejectedValue(new Error("pi rejected"));
    const gateway = createGateway({ agentRuntime: runtime, sessionStoreManager: makeStores() });

    const first = gateway.dispatch({ ...baseMsg, sessionKey: "fail", content: "first" });
    const second = await gateway.dispatch({ ...baseMsg, sessionKey: "fail", content: "second" });

    expect(second.state).toBe("queued");
    expect(second.errorMessage).toBe("pi rejected");

    await gateway.abort(second.sessionId);
    await first;
  });
});

describe("gateway.abort", () => {
  it("cancels in-flight run", async () => {
    let aborted = false;
    const runner: Runner = {
      resolveSessionId: (req) => req.sessionId ?? "stub",
      async *run({ abort }) {
        yield textDelta("x");
        await new Promise<void>((r) => abort.addEventListener("abort", () => { aborted = true; r(); }, { once: true }));
        yield agentEnd();
      },
    };
    const runtime = buildRuntime(runner);
    const gateway = createGateway({ agentRuntime: runtime, sessionStoreManager: makeStores() });

    let capturedSid = "";
    const fut = gateway.dispatch(baseMsg, {
      onTextDelta: () => {
        if (!capturedSid) {
          for (const r of runtime.listRuns()) capturedSid = r.sessionId;
        }
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(capturedSid).toMatch(/^sess-/);
    await gateway.abort(capturedSid, "test");

    const result = await fut;
    expect(result.state).toBe("started");
    expect(aborted).toBe(true);
  });
});

describe("gateway.abortByKey", () => {
  it("resolves sessionKey to sessionId and cancels the run", async () => {
    let aborted = false;
    const runner: Runner = {
      resolveSessionId: (req) => req.sessionId ?? "stub",
      async *run({ abort }) {
        yield textDelta("x");
        await new Promise<void>((r) => abort.addEventListener("abort", () => { aborted = true; r(); }, { once: true }));
        yield agentEnd();
      },
    };
    const runtime = buildRuntime(runner);
    const gateway = createGateway({ agentRuntime: runtime, sessionStoreManager: makeStores() });

    const fut = gateway.dispatch({ ...baseMsg, sessionKey: "discord:bot:channel:c1" });
    await new Promise((r) => setTimeout(r, 10));
    const cancelled = await gateway.abortByKey("main", "discord:bot:channel:c1", "user");
    expect(cancelled).toBe(true);

    const result = await fut;
    expect(result.state).toBe("started");
    expect(aborted).toBe(true);
  });

  it("returns false when no session exists for the key", async () => {
    const runner: Runner = {
      resolveSessionId: (req) => req.sessionId ?? "stub",
      async *run() { yield agentEnd(); },
    };
    const runtime = buildRuntime(runner);
    const gateway = createGateway({ agentRuntime: runtime, sessionStoreManager: makeStores() });

    const cancelled = await gateway.abortByKey("main", "discord:bot:channel:never-existed");
    expect(cancelled).toBe(false);
  });
});
