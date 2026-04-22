// src/core/agent-runner.test.ts — Unit tests for the shared agent event loop

import { describe, it, expect, vi } from "vitest";
import { runAgentLoop } from "./agent-runner.js";
import { createMockSessionStore } from "./test-helpers.js";
import type { AgentServiceCache } from "./pi-mono.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
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

/**
 * Create a mock AgentServiceCache whose createSession() returns a mock session.
 * The session's subscribe() will replay the given events, and prompt() resolves immediately.
 */
function createMockCache(events: AgentEvent[]): {
  cache: AgentServiceCache;
  session: { subscribe: ReturnType<typeof vi.fn>; prompt: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> };
} {
  const session = {
    subscribe: vi.fn((callback: (event: unknown) => void) => {
      // Replay events asynchronously after prompt() is called
      queueMicrotask(() => {
        for (const e of events) {
          callback(e);
        }
      });
      return () => {};
    }),
    prompt: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    steer: vi.fn(),
    abort: vi.fn(),
    agent: { state: { systemPrompt: "" } },
  };

  const cache = {
    createSession: vi.fn().mockResolvedValue(session),
  } as unknown as AgentServiceCache;

  return { cache, session };
}

function createMockSessionStoreWithManager(sessionId = "s1") {
  const store = createMockSessionStore(sessionId);
  (store.getSessionManager as ReturnType<typeof vi.fn>).mockResolvedValue({
    // minimal SessionManager mock
    getMessages: vi.fn().mockResolvedValue([]),
    setMessages: vi.fn(),
  });
  return store;
}

describe("runAgentLoop", () => {
  it("accumulates text_delta events into responseText", async () => {
    const { cache } = createMockCache([
      { type: "message_update", message: {} as never, assistantMessageEvent: { type: "text_delta", delta: "Hello " } as never },
      { type: "message_update", message: {} as never, assistantMessageEvent: { type: "text_delta", delta: "world!" } as never },
      { type: "agent_end", messages: [] },
    ]);
    const sessionStore = createMockSessionStoreWithManager();

    const result = await runAgentLoop({
      cache,
      sessionStore,
      sessionId: "s1",
      systemPrompt: "test",
      textInput: "hi",
      log: createMockLogger(),
    });

    expect(result.responseText).toBe("Hello world!");
    expect(result.errorMessage).toBeNull();
  });

  it("captures error message on agent_end with error stopReason", async () => {
    const { cache } = createMockCache([
      { type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "API key invalid", timestamp: Date.now() } as never] },
    ]);
    const log = createMockLogger();

    const result = await runAgentLoop({
      cache,
      sessionStore: createMockSessionStoreWithManager(),
      sessionId: "s1",
      systemPrompt: "test",
      textInput: "hi",
      log,
    });

    expect(result.errorMessage).toBe("API key invalid");
    expect(log.error).toHaveBeenCalledWith("Agent ended with error: API key invalid");
  });

  it("defaults errorMessage to 'Unknown agent error'", async () => {
    const { cache } = createMockCache([
      { type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", timestamp: Date.now() } as never] },
    ]);

    const result = await runAgentLoop({
      cache,
      sessionStore: createMockSessionStoreWithManager(),
      sessionId: "s1",
      systemPrompt: "test",
      textInput: "hi",
      log: createMockLogger(),
    });

    expect(result.errorMessage).toBe("Unknown agent error");
  });

  it("calls onTextDelta with accumulated text", async () => {
    const { cache } = createMockCache([
      { type: "message_update", message: {} as never, assistantMessageEvent: { type: "text_delta", delta: "a" } as never },
      { type: "message_update", message: {} as never, assistantMessageEvent: { type: "text_delta", delta: "b" } as never },
      { type: "agent_end", messages: [] },
    ]);

    const deltas: string[] = [];
    await runAgentLoop({
      cache,
      sessionStore: createMockSessionStoreWithManager(),
      sessionId: "s1",
      systemPrompt: "test",
      textInput: "hi",
      log: createMockLogger(),
      onTextDelta: (text) => { deltas.push(text); },
    });

    expect(deltas).toEqual(["a", "ab"]);
  });

  it("calls onToolComplete after turn_end and injects via steer", async () => {
    const { cache, session } = createMockCache([
      { type: "turn_end", message: {} as never, toolResults: [] },
      { type: "agent_end", messages: [] },
    ]);
    const onToolComplete = vi.fn().mockResolvedValue("[Messages arrived]\nuser1: hello");

    await runAgentLoop({
      cache,
      sessionStore: createMockSessionStoreWithManager(),
      sessionId: "s1",
      systemPrompt: "test",
      textInput: "hi",
      log: createMockLogger(),
      onToolComplete,
    });

    // Allow async onToolComplete to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(onToolComplete).toHaveBeenCalledTimes(1);
    expect(session.steer).toHaveBeenCalledWith("[Messages arrived]\nuser1: hello");
  });

  it("does not call steer if onToolComplete returns null", async () => {
    const { cache, session } = createMockCache([
      { type: "turn_end", message: {} as never, toolResults: [] },
      { type: "agent_end", messages: [] },
    ]);
    const onToolComplete = vi.fn().mockResolvedValue(null);

    await runAgentLoop({
      cache,
      sessionStore: createMockSessionStoreWithManager(),
      sessionId: "s1",
      systemPrompt: "test",
      textInput: "hi",
      log: createMockLogger(),
      onToolComplete,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(onToolComplete).toHaveBeenCalledTimes(1);
    expect(session.steer).not.toHaveBeenCalled();
  });

  it("does not call onToolComplete if not provided", async () => {
    const { cache, session } = createMockCache([
      { type: "turn_end", message: {} as never, toolResults: [] },
      { type: "agent_end", messages: [] },
    ]);

    await runAgentLoop({
      cache,
      sessionStore: createMockSessionStoreWithManager(),
      sessionId: "s1",
      systemPrompt: "test",
      textInput: "hi",
      log: createMockLogger(),
    });

    // Should not crash, just skip the callback
    expect(session.steer).not.toHaveBeenCalled();
  });

  it("disposes the session after completion", async () => {
    const { cache, session } = createMockCache([
      { type: "agent_end", messages: [] },
    ]);

    await runAgentLoop({
      cache,
      sessionStore: createMockSessionStoreWithManager(),
      sessionId: "s1",
      systemPrompt: "test",
      textInput: "hi",
      log: createMockLogger(),
    });

    expect(session.dispose).toHaveBeenCalled();
  });
});
