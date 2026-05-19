import { describe, it, expect, vi } from "vitest";
import { createGateway } from "./gateway.js";
import { AgentRuntime, type Runner } from "../agent/runtime.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { Message, SessionEvent } from "./types.js";

let nextSessionId = 0;

function makeStores() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stores = new Map<string, any>();
  function makeStore() {
    const sessions = new Map();
    const byKey = new Map<string, string>();
    const listenersBySession = new Map<string, Set<(u: { message: unknown; messageId: string }) => void>>();
    return {
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
      async get(id: string) { return sessions.get(id); },
      async list() { return [...sessions.values()]; },
      async getMessages() { return []; },
      async delete(id: string) {
        const s = sessions.get(id);
        if (s?.metadata?.key) byKey.delete(s.metadata.key);
        sessions.delete(id);
      },
      subscribe(sessionId: string, listener: (u: { message: unknown; messageId: string }) => void) {
        let set = listenersBySession.get(sessionId);
        if (!set) { set = new Set(); listenersBySession.set(sessionId, set); }
        set.add(listener);
        return () => { set?.delete(listener); };
      },
    };
  }
  return {
    async getOrCreate(agentId: string) {
      let s = stores.get(agentId);
      if (!s) { s = makeStore(); stores.set(agentId, s); }
      return s;
    },
    peek(agentId: string) {
      return stores.get(agentId);
    },
    all() {
      return stores.entries();
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

// Helper: collect all SessionEvents from subscribe until agent_end resolves.
async function dispatchAndCollect(
  gateway: ReturnType<typeof createGateway>,
  msg: Message,
): Promise<{ sessionId: string; state: string; events: SessionEvent[] }> {
  const events: SessionEvent[] = [];
  const { sessionKey } = await gateway.createOrResumeSession(msg.agentId, msg.sessionKey);
  const ready = new Promise<void>((resolve) => {
    void gateway.subscribe(msg.agentId, sessionKey, (event) => {
      events.push(event);
      if (event.type === "agent_end") resolve();
    });
  });
  await gateway.dispatch({ ...msg, sessionKey });
  await ready;
  const session = await gateway.getSession(msg.agentId, sessionKey);
  return { sessionId: session?.id ?? "", state: "new_run", events };
}

describe("gateway.dispatchAndWait", () => {
  it("returns final responseText after agent_end", async () => {
    const runtime = buildRuntime(fastRunner(["hel", "lo, ", "world"]));
    const gateway = createGateway({ agentRuntime: runtime, sessionStoreManager: makeStores() });

    const result = await gateway.dispatchAndWait(baseMsg);
    expect(result.responseText).toBe("hello, world");
    expect(result.errorMessage).toBeNull();
  });

  it("captures errorMessage from agent_end", async () => {
    const runtime = buildRuntime(fastRunner(["x"], "error", "boom"));
    const gateway = createGateway({ agentRuntime: runtime, sessionStoreManager: makeStores() });

    const result = await gateway.dispatchAndWait(baseMsg);
    expect(result.errorMessage).toBe("boom");
  });
});

describe("gateway.dispatch (new_run)", () => {
  it("returns new_run state and surfaces text_delta + agent_end on subscribers", async () => {
    const runtime = buildRuntime(fastRunner(["a", "b"]));
    const gateway = createGateway({ agentRuntime: runtime, sessionStoreManager: makeStores() });

    const { events, state } = await dispatchAndCollect(gateway, { ...baseMsg, sessionKey: "k1" });
    expect(state).toBe("new_run");
    const textDeltas = events.filter((e): e is Extract<SessionEvent, { type: "text_delta" }> => e.type === "text_delta");
    expect(textDeltas.map((e) => e.delta)).toEqual(["a", "b"]);
    expect(events.at(-1)?.type).toBe("agent_end");
  });

  it("emits tool_call + tool_result for tool events", async () => {
    const toolStart: AgentEvent = { type: "tool_execution_start", toolCallId: "t1", toolName: "echo", args: { x: 1 } };
    const toolEnd: AgentEvent = { type: "tool_execution_end", toolCallId: "t1", toolName: "echo", result: "done", isError: false };
    const runner: Runner = {
      resolveSessionId: (req) => req.sessionId ?? "stub",
      async *run() { yield textDelta("a"); yield toolStart; yield toolEnd; yield agentEnd("a"); },
    };
    const gateway = createGateway({ agentRuntime: buildRuntime(runner), sessionStoreManager: makeStores() });
    const { events } = await dispatchAndCollect(gateway, { ...baseMsg, sessionKey: "k2" });
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({ toolCallId: "t1", toolName: "echo", args: { x: 1 } });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ toolCallId: "t1", toolName: "echo", result: "done", isError: false });
  });
});

describe("gateway.dispatch (steered)", () => {
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
    await first; // dispatch resolves early on handle.ready
    const second = await gateway.dispatch({ ...baseMsg, sessionKey: "shared", content: "second" });
    expect(second.state).toBe("steered");
    expect(steerSpy).toHaveBeenCalledWith(second.sessionId, "second");

    await gateway.abort(second.sessionId);
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
    const runtime = buildRuntime(fastRunner(["one"]));
    const steerSpy = vi.spyOn(runtime, "steer");
    const gateway = createGateway({ agentRuntime: runtime, sessionStoreManager: makeStores() });

    const first = await gateway.dispatchAndWait({ ...baseMsg, sessionKey: "ended", content: "first" });
    expect(first.responseText).toBe("one");

    const second = await gateway.dispatchAndWait({ ...baseMsg, sessionKey: "ended", content: "second" });
    expect(second.responseText).toBe("one");
    expect(steerSpy).not.toHaveBeenCalled();
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

    const ack = await gateway.dispatch({ ...baseMsg, sessionKey: "abk" });
    await gateway.abort(ack.sessionId, "test");
    // give the run time to wind down
    await new Promise((r) => setTimeout(r, 10));
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

    await gateway.dispatch({ ...baseMsg, sessionKey: "discord:bot:channel:c1" });
    await new Promise((r) => setTimeout(r, 10));
    const cancelled = await gateway.abortByKey("main", "discord:bot:channel:c1", "user");
    expect(cancelled).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
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
