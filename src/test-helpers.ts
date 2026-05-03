// src/test-helpers.ts — Shared test mocks for transport tests

import { vi } from "vitest";
import type { SessionStore } from "./sessions/types.js";

export function createMockSession() {
  let subscriber: ((event: Record<string, unknown>) => void) | null = null;

  const session = {
    subscribe: vi.fn((cb: (event: Record<string, unknown>) => void) => {
      subscriber = cb;
      return () => { subscriber = null; };
    }),
    prompt: vi.fn(async () => {
      if (subscriber) {
        subscriber({
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", delta: "Hello world!" },
        });
        subscriber({
          type: "agent_end",
          messages: [],
        });
      }
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    compact: vi.fn(),
    dispose: vi.fn(),
    agent: { state: { systemPrompt: "" } },
  };

  return session;
}

/**
 * Create a mock SessionStore with sensible defaults.
 *
 * - `findByKey` returns undefined (no existing session)
 * - `create` returns a session with the given sessionId (default: "session-123")
 * - `getMessages` returns an empty array
 */
export function createMockSessionStore(sessionId = "session-123"): SessionStore {
  return {
    create: vi.fn().mockResolvedValue({
      id: sessionId,
      agentId: "default",
      lastActiveAt: new Date(),
    }),
    get: vi.fn(),
    findByKey: vi.fn().mockResolvedValue(undefined),
    addMessage: vi.fn(),
    getMessages: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    clearMessages: vi.fn(),
    getSessionManager: vi.fn().mockResolvedValue({
      loadMessages: vi.fn().mockReturnValue([]),
      appendMessage: vi.fn(),
    }),
    attach: vi.fn().mockReturnValue(() => {}),
  };
}
