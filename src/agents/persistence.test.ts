import { describe, it, expect, vi } from "vitest";
import {
  runEventToMessage,
  terminalEventPatch,
  createRunRecorder,
  buildRunSessionKey,
} from "./persistence.js";
import type { RunEvent } from "./types.js";
import { msgField } from "../core/messages.js";
import type { SessionStore, AgentMessage, Session } from "../core/types.js";

describe("buildRunSessionKey", () => {
  it("produces the expected sessionKey", () => {
    const key = buildRunSessionKey("code-reviewer");
    expect(key.startsWith("agent:code-reviewer:run:")).toBe(true);
    const uuid = key.slice("agent:code-reviewer:run:".length);
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("produces a fresh uuid each call", () => {
    expect(buildRunSessionKey("alice")).not.toBe(buildRunSessionKey("alice"));
  });
});

describe("runEventToMessage", () => {
  it("returns undefined for control events", () => {
    expect(runEventToMessage({ type: "run:start" })).toBeUndefined();
    expect(runEventToMessage({ type: "run:done", exitCode: 0 })).toBeUndefined();
  });

  it("converts message events to assistant text", () => {
    const msg = runEventToMessage({ type: "run:message", content: "hello" });
    expect(msg?.role).toBe("assistant");
    expect(msg ? msgField(msg, "content") : undefined).toEqual([{ type: "text", text: "hello" }]);
  });

  it("skips empty messages", () => {
    expect(runEventToMessage({ type: "run:message", content: "" })).toBeUndefined();
  });

  it("encodes tool_use as text with tool name + input", () => {
    const msg = runEventToMessage({
      type: "run:tool_use",
      toolName: "Read",
      toolInput: { path: "x" },
    });
    expect(msg?.role).toBe("assistant");
    const text = (msgField<Array<{ text: string }>>(msg!, "content") ?? [])[0]?.text;
    expect(text).toContain("🔧 Read(");
    expect(text).toContain("\"path\"");
  });

  it("converts tool_result to toolResult message", () => {
    const msg = runEventToMessage({
      type: "run:tool_result",
      toolName: "Read",
      toolResult: "file contents",
    });
    expect(msg?.role).toBe("toolResult");
    expect(msg ? msgField(msg, "content") : undefined).toBe("file contents");
    expect(msg ? msgField(msg, "toolName") : undefined).toBe("Read");
  });

  it("flags error events with error text in content", () => {
    const msg = runEventToMessage({ type: "run:error", error: "boom" });
    expect(msg?.role).toBe("assistant");
    const content = msg ? msgField<Array<{ text: string }>>(msg, "content") : [];
    expect(content[0].text).toContain("boom");
  });

  it("truncates oversized tool_result", () => {
    const long = "x".repeat(10_000);
    const msg = runEventToMessage({ type: "run:tool_result", toolName: "test", toolResult: long });
    const content = msg ? msgField<string>(msg, "content") : "";
    expect(content.length).toBeLessThan(long.length);
    expect(content.endsWith("…")).toBe(true);
  });
});

describe("terminalEventPatch", () => {
  it("extracts exitCode/cost from done", () => {
    expect(terminalEventPatch({ type: "run:done", exitCode: 0, costUsd: 0.42 })).toEqual({
      exitCode: 0,
      costUsd: 0.42,
    });
  });

  it("captures error from error event", () => {
    expect(terminalEventPatch({ type: "run:error", error: "x" })).toEqual({ error: "x" });
  });

  it("returns undefined for non-terminal events", () => {
    expect(terminalEventPatch({ type: "run:message", content: "hi" })).toBeUndefined();
    expect(terminalEventPatch({ type: "run:start" })).toBeUndefined();
  });
});

function fakeStore(): SessionStore & {
  __session: Session;
  __messages: AgentMessage[];
} {
  const session: Session = {
    id: "sess-1",
    agentId: "dev",
    metadata: {},
    lastActiveAt: new Date(),
  };
  const messages: AgentMessage[] = [];
  return {
    __session: session,
    __messages: messages,
    create: vi.fn(async (agentId, metadata) => {
      session.agentId = agentId;
      session.metadata = metadata;
      return session;
    }),
    get: vi.fn(async () => session),
    findByKey: vi.fn(async () => undefined),
    addMessage: vi.fn(async (_id, msg) => {
      messages.push(msg);
    }),
    getMessages: vi.fn(async () => [...messages]),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => [session]),
    clearMessages: vi.fn(async () => {
      messages.length = 0;
    }),
    setMessages: vi.fn(async (_id, msgs) => {
      messages.length = 0;
      messages.push(...msgs);
    }),
    setMetadata: vi.fn(async (_id, patch) => {
      session.metadata = { ...(session.metadata ?? {}), ...patch };
    }),
    getSessionManager: vi.fn(async () => undefined),
  };
}

describe("createRunRecorder", () => {
  it("is a no-op when no store is provided", async () => {
    const r = await createRunRecorder({
      targetAgentId: "dev",
      parentAgentId: "dev",
      taskId: "task-1",
      backend: "external",
    });
    expect(r.sessionId).toBeUndefined();
    await r.record({ type: "run:message", content: "hi" });
    await r.patchMetadata({ exitCode: 0 });
  });

  it("creates session under the target agentId with run metadata", async () => {
    const store = fakeStore();
    const r = await createRunRecorder({
      store,
      targetAgentId: "code-reviewer",
      parentAgentId: "dev",
      parentSessionId: "parent-sess",
      taskId: "task-1",
      backend: "external",
      cwd: "/work",
      prompt: "do it",
      channelId: "C1",
      threadId: "T1",
    });
    expect(r.sessionId).toBe("sess-1");
    expect(store.create).toHaveBeenCalledWith(
      "code-reviewer",
      expect.objectContaining({
        key: expect.stringMatching(/^agent:code-reviewer:run:/),
        channelId: "C1",
        threadId: "T1",
        spawnAgent: expect.objectContaining({
          parentAgentId: "dev",
          parentSessionId: "parent-sess",
          taskId: "task-1",
          backend: "external",
        }),
      }),
    );
    expect(store.__session.metadata?.transport).toBeUndefined();

    const events: RunEvent[] = [
      { type: "run:start" },
      { type: "run:message", content: "hi" },
      { type: "run:tool_use", toolName: "Read", toolInput: { path: "x" } },
      { type: "run:tool_result", toolName: "Read", toolResult: "ok" },
      { type: "run:done", exitCode: 0, costUsd: 0.1 },
    ];
    for (const e of events) await r.record(e);

    expect(store.__messages).toHaveLength(3);
    expect(store.__messages[0]?.role).toBe("assistant");
    expect(store.__messages[2]?.role).toBe("toolResult");
  });

  it("respects a caller-provided sessionKey", async () => {
    const store = fakeStore();
    await createRunRecorder({
      store,
      targetAgentId: "alice",
      parentAgentId: "alice",
      taskId: "task-2",
      backend: "external",
      sessionKey: "agent:alice:run:fixed-key",
    });
    expect(store.create).toHaveBeenCalledWith(
      "alice",
      expect.objectContaining({ key: "agent:alice:run:fixed-key" }),
    );
  });

  it("merges terminal metadata under subagent and computes durationMs", async () => {
    const store = fakeStore();
    const r = await createRunRecorder({
      store,
      targetAgentId: "dev",
      parentAgentId: "dev",
      taskId: "task-9",
      backend: "external",
    });
    await r.patchMetadata({ exitCode: 0, costUsd: 0.5 });
    expect(store.setMetadata).toHaveBeenCalled();
    const patch = (store.setMetadata as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(patch.spawnAgent.exitCode).toBe(0);
    expect(patch.spawnAgent.costUsd).toBe(0.5);
    expect(typeof patch.spawnAgent.durationMs).toBe("number");
    expect(patch.spawnAgent.parentAgentId).toBe("dev");
    expect(patch.spawnAgent.taskId).toBe("task-9");
  });

  it("survives store failures without throwing", async () => {
    const store = fakeStore();
    (store.addMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("disk full"));
    (store.setMetadata as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("disk full"));
    const r = await createRunRecorder({
      store,
      targetAgentId: "dev",
      parentAgentId: "dev",
      taskId: "task-x",
      backend: "external",
    });
    await expect(r.record({ type: "run:message", content: "hi" })).resolves.toBeUndefined();
    await expect(r.patchMetadata({ exitCode: 1, error: "x" })).resolves.toBeUndefined();
  });

  it("returns no-op recorder when store.create throws", async () => {
    const store = fakeStore();
    (store.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("nope"));
    const r = await createRunRecorder({
      store,
      targetAgentId: "dev",
      parentAgentId: "dev",
      taskId: "task-x",
      backend: "external",
    });
    expect(r.sessionId).toBeUndefined();
    await r.record({ type: "run:message", content: "hi" });
    expect(store.addMessage).not.toHaveBeenCalled();
  });
});
