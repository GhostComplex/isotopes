// src/core/agent-runner.test.ts — Unit tests for the shared agent event loop

import { describe, it, expect, vi } from "vitest";
import { runAgentLoop } from "./agent-runner.js";
import { createMockAgentInstance, createMockSessionStore } from "./test-helpers.js";
import { textContent } from "./types.js";
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
        content: textContent("Reply"),
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
});
