// src/core/agent-runner.test.ts — Unit tests for the shared agent event loop

import { describe, it, expect, vi } from "vitest";
import { runAgentLoop } from "./agent-runner.js";
import { createMockAgentInstance, createMockSessionStore } from "./test-helpers.js";
import { msgField } from "./messages.js";
import type { Logger } from "./logger.js";

// Suppress console output
vi.spyOn(console, "error").mockImplementation(() => {});

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

describe("runAgentLoop", () => {
  it("accumulates text_delta events into responseText", async () => {
    const agent = createMockAgentInstance([
      { type: "text_delta", text: "Hello " },
      { type: "text_delta", text: "world!" },
      { type: "agent_end", messages: [] },
    ]);
    const sessionStore = createMockSessionStore();

    const result = await runAgentLoop({
      agent,
      input: "hi",
      sessionId: "s1",
      sessionStore,
      log: createMockLogger(),
    });

    expect(result.responseText).toBe("Hello world!");
    expect(result.errorMessage).toBeNull();
  });

  it("stores assistant message on agent_end", async () => {
    const agent = createMockAgentInstance([
      { type: "text_delta", text: "Reply" },
      { type: "agent_end", messages: [] },
    ]);
    const sessionStore = createMockSessionStore();

    await runAgentLoop({
      agent,
      input: "hi",
      sessionId: "s1",
      sessionStore,
      log: createMockLogger(),
    });

    expect(sessionStore.addMessage).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "Reply" }],
      }),
    );
  });

  it("does not store assistant message when responseText is empty", async () => {
    const agent = createMockAgentInstance([
      { type: "agent_end", messages: [] },
    ]);
    const sessionStore = createMockSessionStore();

    await runAgentLoop({
      agent,
      input: "hi",
      sessionId: "s1",
      sessionStore,
      log: createMockLogger(),
    });

    expect(sessionStore.addMessage).not.toHaveBeenCalled();
  });

  it("captures error message on agent_end with error stopReason", async () => {
    const agent = createMockAgentInstance([
      { type: "agent_end", messages: [], stopReason: "error", errorMessage: "API key invalid" },
    ]);
    const log = createMockLogger();

    const result = await runAgentLoop({
      agent,
      input: "hi",
      sessionId: "s1",
      sessionStore: createMockSessionStore(),
      log,
    });

    expect(result.errorMessage).toBe("API key invalid");
    expect(log.error).toHaveBeenCalledWith("Agent ended with error: API key invalid");
  });

  it("defaults errorMessage to 'Unknown agent error'", async () => {
    const agent = createMockAgentInstance([
      { type: "agent_end", messages: [], stopReason: "error" },
    ]);

    const result = await runAgentLoop({
      agent,
      input: "hi",
      sessionId: "s1",
      sessionStore: createMockSessionStore(),
      log: createMockLogger(),
    });

    expect(result.errorMessage).toBe("Unknown agent error");
  });

  it("calls onTextDelta with accumulated text", async () => {
    const agent = createMockAgentInstance([
      { type: "text_delta", text: "a" },
      { type: "text_delta", text: "b" },
      { type: "agent_end", messages: [] },
    ]);

    const deltas: string[] = [];
    await runAgentLoop({
      agent,
      input: "hi",
      sessionId: "s1",
      sessionStore: createMockSessionStore(),
      log: createMockLogger(),
      onTextDelta: (text) => { deltas.push(text); },
    });

    expect(deltas).toEqual(["a", "ab"]);
  });

  it("calls onToolComplete after turn_end and injects via steer", async () => {
    const agent = createMockAgentInstance([
      { type: "turn_end" },
      { type: "agent_end", messages: [] },
    ]);
    const sessionStore = createMockSessionStore();
    const onToolComplete = vi.fn().mockResolvedValue("[Messages arrived]\nuser1: hello");

    await runAgentLoop({
      agent,
      input: "hi",
      sessionId: "s1",
      sessionStore,
      log: createMockLogger(),
      onToolComplete,
    });

    expect(onToolComplete).toHaveBeenCalledTimes(1);
    expect(agent.steer).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "user",
        content: "[Messages arrived]\nuser1: hello",
      }),
    );
  });

  it("does not call steer if onToolComplete returns null", async () => {
    const agent = createMockAgentInstance([
      { type: "turn_end" },
      { type: "agent_end", messages: [] },
    ]);
    const sessionStore = createMockSessionStore();
    const onToolComplete = vi.fn().mockResolvedValue(null);

    await runAgentLoop({
      agent,
      input: "hi",
      sessionId: "s1",
      sessionStore,
      log: createMockLogger(),
      onToolComplete,
    });

    expect(onToolComplete).toHaveBeenCalledTimes(1);
    expect(agent.steer).not.toHaveBeenCalled();
  });

  it("does not call onToolComplete if not provided", async () => {
    const agent = createMockAgentInstance([
      { type: "turn_end" },
      { type: "agent_end", messages: [] },
    ]);
    const sessionStore = createMockSessionStore();

    await runAgentLoop({
      agent,
      input: "hi",
      sessionId: "s1",
      sessionStore,
      log: createMockLogger(),
    });

    // Should not crash, just skip the callback
    expect(agent.steer).not.toHaveBeenCalled();
  });

  it("persists tool_call blocks on the assistant message and tool_result as its own message", async () => {
    const agent = createMockAgentInstance([
      { type: "text_delta", text: "Let me check." },
      { type: "tool_call", id: "call-1", name: "shell", args: { cmd: "ls" } },
      { type: "tool_result", id: "call-1", output: "a.txt\nb.txt" },
      { type: "turn_end" },
      { type: "text_delta", text: "Done." },
      { type: "turn_end" },
      { type: "agent_end", messages: [] },
    ]);
    const sessionStore = createMockSessionStore();

    await runAgentLoop({
      agent,
      input: "list files",
      sessionId: "s1",
      sessionStore,
      log: createMockLogger(),
    });

    const calls = (sessionStore.addMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(3);

    // Turn 1: assistant with text + tool_call
    expect(calls[0][0]).toBe("s1");
    expect(msgField(calls[0][1], "role")).toBe("assistant");
    expect(msgField(calls[0][1], "content")).toEqual([
      { type: "text", text: "Let me check." },
      { type: "toolCall", id: "call-1", name: "shell", input: { cmd: "ls" } },
    ]);

    // Turn 1: tool_result-role message paired to call-1, with toolName
    expect(msgField(calls[1][1], "role")).toBe("toolResult");
    expect(msgField(calls[1][1], "content")).toBe("a.txt\nb.txt");
    expect(msgField(calls[1][1], "toolCallId")).toBe("call-1");
    expect(msgField(calls[1][1], "toolName")).toBe("shell");

    // Turn 2: text-only assistant
    expect(msgField(calls[2][1], "role")).toBe("assistant");
    expect(msgField(calls[2][1], "content")).toEqual([{ type: "text", text: "Done." }]);
  });

  it("truncates oversized tool_result output when persisting", async () => {
    const big = "x".repeat(30_000);
    const agent = createMockAgentInstance([
      { type: "tool_call", id: "c", name: "read_file", args: {} },
      { type: "tool_result", id: "c", output: big },
      { type: "turn_end" },
      { type: "agent_end", messages: [] },
    ]);
    const sessionStore = createMockSessionStore();

    await runAgentLoop({
      agent,
      input: "read",
      sessionId: "s1",
      sessionStore,
      log: createMockLogger(),
    });

    const toolResultCall = (sessionStore.addMessage as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1].role === "toolResult",
    );
    expect(toolResultCall).toBeDefined();
    const output = msgField(toolResultCall![1], "content") as string;
    expect(output.length).toBeLessThan(big.length);
    expect(output).toContain("[truncated");
  });

  it("propagates isError on tool_result blocks", async () => {
    const agent = createMockAgentInstance([
      { type: "tool_call", id: "c", name: "shell", args: {} },
      { type: "tool_result", id: "c", output: "boom", isError: true },
      { type: "turn_end" },
      { type: "agent_end", messages: [] },
    ]);
    const sessionStore = createMockSessionStore();

    await runAgentLoop({
      agent,
      input: "x",
      sessionId: "s1",
      sessionStore,
      log: createMockLogger(),
    });

    const toolResultCall = (sessionStore.addMessage as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1].role === "toolResult",
    );
    expect(msgField(toolResultCall![1], "isError")).toBe(true);
  });

  it("flushes accumulated tool_calls at agent_end when turn_end is missing", async () => {
    const agent = createMockAgentInstance([
      { type: "text_delta", text: "partial" },
      { type: "tool_call", id: "c", name: "t", args: {} },
      { type: "agent_end", messages: [] },
    ]);
    const sessionStore = createMockSessionStore();

    await runAgentLoop({
      agent,
      input: "x",
      sessionId: "s1",
      sessionStore,
      log: createMockLogger(),
    });

    const calls = (sessionStore.addMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(msgField(calls[0][1], "role")).toBe("assistant");
    expect(msgField(calls[0][1], "content")).toEqual([
      { type: "text", text: "partial" },
      { type: "toolCall", id: "c", name: "t", input: {} },
    ]);
  });
});
