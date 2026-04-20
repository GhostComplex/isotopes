// src/subagent/persistence.test.ts — adapter + recorder tests.
import { describe, it, expect, vi } from "vitest";
import {
  eventToMessage,
  terminalEventPatch,
  createSubagentRecorder,
  buildSubagentSessionKey,
} from "./persistence.js";
import type { SubagentEvent } from "./types.js";
import type { SessionStore, Message, Session } from "../core/types.js";

describe("buildSubagentSessionKey", () => {
  it("produces the openclaw-style sessionKey", () => {
    const key = buildSubagentSessionKey("code-reviewer");
    expect(key.startsWith("agent:code-reviewer:subagent:")).toBe(true);
    // suffix should be a UUID-shaped string (8-4-4-4-12)
    const uuid = key.slice("agent:code-reviewer:subagent:".length);
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("produces a fresh uuid each call", () => {
    expect(buildSubagentSessionKey("alice")).not.toBe(buildSubagentSessionKey("alice"));
  });
});

describe("eventToMessage", () => {
  it("returns undefined for control events", () => {
    expect(eventToMessage({ type: "start" })).toBeUndefined();
    expect(eventToMessage({ type: "done", exitCode: 0 })).toBeUndefined();
  });

  it("converts message events to assistant text", () => {
    const msg = eventToMessage({ type: "message", content: "hello" });
    expect(msg?.role).toBe("assistant");
    expect(msg?.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("skips empty messages", () => {
    expect(eventToMessage({ type: "message", content: "" })).toBeUndefined();
    expect(eventToMessage({ type: "message" })).toBeUndefined();
  });

  it("encodes tool_use as text with tool name + input", () => {
    const msg = eventToMessage({
      type: "tool_use",
      toolName: "Read",
      toolInput: { path: "x" },
    });
    expect(msg?.role).toBe("assistant");
    const text = (msg?.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("🔧 Read(");
    expect(text).toContain("\"path\"");
  });

  it("converts tool_result to tool_result block", () => {
    const msg = eventToMessage({
      type: "tool_result",
      toolName: "Read",
      toolResult: "file contents",
    });
    expect(msg?.role).toBe("tool_result");
    expect(msg?.content[0]).toMatchObject({
      type: "tool_result",
      output: "file contents",
      toolName: "Read",
    });
  });

  it("flags error events in metadata", () => {
    const msg = eventToMessage({ type: "error", error: "boom" });
    expect(msg?.metadata?.error).toBe(true);
    const text = (msg?.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("boom");
  });

  it("truncates oversized tool_result", () => {
    const long = "x".repeat(10_000);
    const msg = eventToMessage({ type: "tool_result", toolResult: long });
    const block = msg?.content[0] as { type: "tool_result"; output: string };
    expect(block.output.length).toBeLessThan(long.length);
    expect(block.output.endsWith("…")).toBe(true);
  });
});

describe("terminalEventPatch", () => {
  it("extracts exitCode/cost from done", () => {
    expect(terminalEventPatch({ type: "done", exitCode: 0, costUsd: 0.42 })).toEqual({
      exitCode: 0,
      costUsd: 0.42,
    });
  });

  it("captures error from error event", () => {
    expect(terminalEventPatch({ type: "error", error: "x" })).toEqual({ error: "x" });
  });

  it("returns undefined for non-terminal events", () => {
    expect(terminalEventPatch({ type: "message", content: "hi" })).toBeUndefined();
    expect(terminalEventPatch({ type: "start" })).toBeUndefined();
  });
});

function fakeStore(): SessionStore & {
  __session: Session;
  __messages: Message[];
} {
  const session: Session = {
    id: "sess-1",
    agentId: "dev",
    metadata: {},
    lastActiveAt: new Date(),
  };
  const messages: Message[] = [];
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
  };
}

describe("createSubagentRecorder", () => {
  it("is a no-op when no store is provided", async () => {
    const r = await createSubagentRecorder({
      targetAgentId: "dev",
      parentAgentId: "dev",
      taskId: "task-1",
      backend: "claude",
    });
    expect(r.sessionId).toBeUndefined();
    await r.record({ type: "message", content: "hi" });
    await r.patchMetadata({ exitCode: 0 });
  });

  it("creates session under the target agentId with subagent metadata", async () => {
    const store = fakeStore();
    const r = await createSubagentRecorder({
      store,
      targetAgentId: "code-reviewer",
      parentAgentId: "dev",
      parentSessionId: "parent-sess",
      taskId: "task-1",
      backend: "claude",
      cwd: "/work",
      prompt: "do it",
      channelId: "C1",
      threadId: "T1",
    });
    expect(r.sessionId).toBe("sess-1");
    expect(store.create).toHaveBeenCalledWith(
      "code-reviewer",
      expect.objectContaining({
        key: expect.stringMatching(/^agent:code-reviewer:subagent:/),
        channelId: "C1",
        threadId: "T1",
        subagent: expect.objectContaining({
          parentAgentId: "dev",
          parentSessionId: "parent-sess",
          taskId: "task-1",
          backend: "claude",
        }),
      }),
    );
    expect(store.__session.metadata?.transport).toBeUndefined();

    const events: SubagentEvent[] = [
      { type: "start" }, // skipped
      { type: "message", content: "hi" },
      { type: "tool_use", toolName: "Read", toolInput: { path: "x" } },
      { type: "tool_result", toolName: "Read", toolResult: "ok" },
      { type: "done", exitCode: 0, costUsd: 0.1 }, // skipped
    ];
    for (const e of events) await r.record(e);

    expect(store.__messages).toHaveLength(3);
    expect(store.__messages[0]?.role).toBe("assistant");
    expect(store.__messages[2]?.role).toBe("tool_result");
  });

  it("respects a caller-provided sessionKey", async () => {
    const store = fakeStore();
    await createSubagentRecorder({
      store,
      targetAgentId: "alice",
      parentAgentId: "alice",
      taskId: "task-2",
      backend: "claude",
      sessionKey: "agent:alice:subagent:fixed-key",
    });
    expect(store.create).toHaveBeenCalledWith(
      "alice",
      expect.objectContaining({ key: "agent:alice:subagent:fixed-key" }),
    );
  });

  it("merges terminal metadata under subagent and computes durationMs", async () => {
    const store = fakeStore();
    const r = await createSubagentRecorder({
      store,
      targetAgentId: "dev",
      parentAgentId: "dev",
      taskId: "task-9",
      backend: "claude",
    });
    await r.patchMetadata({ exitCode: 0, costUsd: 0.5 });
    expect(store.setMetadata).toHaveBeenCalled();
    const patch = (store.setMetadata as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(patch.subagent.exitCode).toBe(0);
    expect(patch.subagent.costUsd).toBe(0.5);
    expect(typeof patch.subagent.durationMs).toBe("number");
    expect(patch.subagent.parentAgentId).toBe("dev");
    expect(patch.subagent.taskId).toBe("task-9");
  });

  it("survives store failures without throwing", async () => {
    const store = fakeStore();
    (store.addMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("disk full"));
    (store.setMetadata as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("disk full"));
    const r = await createSubagentRecorder({
      store,
      targetAgentId: "dev",
      parentAgentId: "dev",
      taskId: "task-x",
      backend: "claude",
    });
    await expect(r.record({ type: "message", content: "hi" })).resolves.toBeUndefined();
    await expect(r.patchMetadata({ exitCode: 1, error: "x" })).resolves.toBeUndefined();
  });

  it("returns no-op recorder when store.create throws", async () => {
    const store = fakeStore();
    (store.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("nope"));
    const r = await createSubagentRecorder({
      store,
      targetAgentId: "dev",
      parentAgentId: "dev",
      taskId: "task-x",
      backend: "claude",
    });
    expect(r.sessionId).toBeUndefined();
    await r.record({ type: "message", content: "hi" });
    expect(store.addMessage).not.toHaveBeenCalled();
  });
});
