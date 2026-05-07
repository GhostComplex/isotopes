// Integration test for gateway: stub Runner + in-memory SessionStoreManager.

import { describe, it, expect } from "vitest";
import { createGateway } from "./gateway.js";
import { AgentRuntime, type Runner } from "../agent/runtime.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { Message } from "./types.js";
import type { Session, SessionMetadata } from "../sessions/types.js";

let nextSessionId = 0;

function makeSessionStore() {
  const sessions = new Map<string, Session>();
  const byKey = new Map<string, string>();
  return {
    async create(agentId: string, metadata?: SessionMetadata): Promise<Session> {
      const id = `sess-${++nextSessionId}`;
      const s: Session = { id, agentId, metadata, lastActiveAt: new Date() };
      sessions.set(id, s);
      if (metadata?.key) byKey.set(metadata.key, id);
      return s;
    },
    async findByKey(key: string): Promise<Session | undefined> {
      const id = byKey.get(key);
      return id ? sessions.get(id) : undefined;
    },
  } as never;
}

function makeSessionStoreManager() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stores = new Map<string, any>();
  return {
    async getOrCreate(agentId: string) {
      let s = stores.get(agentId);
      if (!s) { s = makeSessionStore(); stores.set(agentId, s); }
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

function turnEnd(): AgentEvent {
  return { type: "turn_end", message: {} as never, toolResults: [] };
}

function agentEnd(text = "done"): AgentEvent {
  return {
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "end" }] as never,
  };
}

function singleTurnRunner(deltas: string[]): Runner {
  return {
    resolveSessionId: (req) => req.sessionId ?? "stub",
    async *run() {
      for (const d of deltas) yield textDelta(d);
      yield turnEnd();
      yield agentEnd(deltas.join(""));
    },
  };
}

function buildRuntime(runner: Runner) {
  const rt = new AgentRuntime();
  rt.registerRunner("main", runner);
  return rt;
}

const baseMsg: Message = { agentId: "main", content: "hi", source: "tui" };

describe("gateway.send", () => {
  it("returns started + sessionId for fresh session", async () => {
    const runtime = buildRuntime(singleTurnRunner(["hel", "lo"]));
    const gateway = createGateway({ runtime, sessionStoreManager: makeSessionStoreManager() });

    const result = await gateway.send(baseMsg);
    expect(result.state).toBe("started");
    expect(result.sessionId).toMatch(/^sess-/);
  });

  it("emits events through subscribe", async () => {
    const runtime = buildRuntime(singleTurnRunner(["abc"]));
    const gateway = createGateway({ runtime, sessionStoreManager: makeSessionStoreManager() });

    const collected: AgentEvent[] = [];
    let resolveDone: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });

    const result = await gateway.send(baseMsg);
    gateway.events.subscribe({ sessionId: result.sessionId }, (e) => {
      collected.push(e);
      if (e.type === "agent_end") resolveDone();
    });
    // Subscribe after send, may miss early events. Wait and check at least agent_end fired.
    await done;
    expect(collected.some((e) => e.type === "agent_end")).toBe(true);
  });
});

describe("gateway.sendAndWait", () => {
  it("collects responseText across deltas", async () => {
    const runtime = buildRuntime(singleTurnRunner(["hel", "lo, ", "world"]));
    const gateway = createGateway({ runtime, sessionStoreManager: makeSessionStoreManager() });

    const result = await gateway.sendAndWait(baseMsg);
    expect(result.responseText).toBe("hello, world");
    expect(result.errorMessage).toBeNull();
  });

  it("returns sessionId", async () => {
    const runtime = buildRuntime(singleTurnRunner(["x"]));
    const gateway = createGateway({ runtime, sessionStoreManager: makeSessionStoreManager() });

    const result = await gateway.sendAndWait(baseMsg);
    expect(result.sessionId).toMatch(/^sess-/);
  });
});

describe("gateway.send buffering", () => {
  it("returns buffered when session already running", async () => {
    // A runner that hangs so the session stays running
    const longRunner: Runner = {
      resolveSessionId: (req) => req.sessionId ?? "stub",
      async *run({ abort }) {
        yield textDelta("running...");
        // wait on abort
        await new Promise((resolve) => abort.addEventListener("abort", resolve, { once: true }));
        yield agentEnd();
      },
    };

    const runtime = buildRuntime(longRunner);
    const gateway = createGateway({ runtime, sessionStoreManager: makeSessionStoreManager() });

    const first = await gateway.send({ ...baseMsg, sessionKey: "shared" });
    // Wait a tick for runtime.runs.set
    await new Promise((r) => setTimeout(r, 5));
    const second = await gateway.send({ ...baseMsg, sessionKey: "shared", content: "again" });

    expect(first.state).toBe("started");
    expect(second.state).toBe("buffered");
    expect(second.queueDepth).toBe(1);
    expect(second.sessionId).toBe(first.sessionId);

    await gateway.abort(first.sessionId);
  });
});

describe("gateway.abort", () => {
  it("cancels in-flight run", async () => {
    let aborted = false;
    const runner: Runner = {
      resolveSessionId: (req) => req.sessionId ?? "stub",
      async *run({ abort }) {
        yield textDelta("starting");
        await new Promise((resolve) => abort.addEventListener("abort", () => { aborted = true; resolve(undefined); }, { once: true }));
        yield agentEnd();
      },
    };
    const runtime = buildRuntime(runner);
    const gateway = createGateway({ runtime, sessionStoreManager: makeSessionStoreManager() });

    const result = await gateway.send(baseMsg);
    await new Promise((r) => setTimeout(r, 5));
    await gateway.abort(result.sessionId, "test");
    await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe(true);
  });
});
