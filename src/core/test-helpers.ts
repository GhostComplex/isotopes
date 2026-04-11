// src/core/test-helpers.ts — Shared test mocks for transport tests
// DRY: both discord.test.ts and feishu.test.ts need identical AgentManager
// and SessionStore mocks. Centralise them here.

import { vi } from "vitest";
import type { AgentInstance, AgentManager, SessionStore, AgentEvent } from "./types.js";

/**
 * Create a mock AgentInstance whose prompt() yields the given events.
 *
 * If no events are provided, yields two text_delta events ("Hello ", "world!")
 * followed by an agent_end event.
 */
export function createMockAgentInstance(events?: AgentEvent[]): AgentInstance {
  const defaultEvents: AgentEvent[] = [
    { type: "text_delta", text: "Hello " },
    { type: "text_delta", text: "world!" },
    { type: "agent_end", messages: [] },
  ];

  const items = events ?? defaultEvents;

  return {
    prompt: vi.fn(async function* () {
      for (const event of items) {
        yield event;
      }
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
  };
}

/**
 * Create a mock AgentManager that returns a single shared AgentInstance
 * from get().
 *
 * @param instance — optional pre-built mock instance; defaults to
 *   createMockAgentInstance() with the standard text_delta sequence.
 */
export function createMockAgentManager(instance?: AgentInstance): AgentManager {
  const mockInstance = instance ?? createMockAgentInstance();

  return {
    create: vi.fn(),
    get: vi.fn(() => mockInstance),
    list: vi.fn(() => []),
    update: vi.fn(),
    delete: vi.fn(),
    getPrompt: vi.fn(),
    updatePrompt: vi.fn(),
    reloadWorkspace: vi.fn(),
  };
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
  };
}
