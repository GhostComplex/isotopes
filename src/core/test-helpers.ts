// src/core/test-helpers.ts — Shared test mocks for transport tests
// DRY: both discord.test.ts and feishu.test.ts need identical AgentManager
// and SessionStore mocks. Centralise them here.

import { vi } from "vitest";
import type { SessionStore } from "./types.js";
import type { AgentServiceCache } from "./pi-mono.js";
import type { DefaultAgentManager } from "./agent-manager.js";

export function createMockAgentCache(): AgentServiceCache {
  const mockSession = createMockSession();
  return {
    createSession: vi.fn().mockResolvedValue(mockSession),
    _mockSession: mockSession,
  } as unknown as AgentServiceCache;
}

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

export function createMockAgentManager(cache?: AgentServiceCache): DefaultAgentManager {
  const mockCache = cache ?? createMockAgentCache();

  return {
    create: vi.fn(),
    get: vi.fn(() => mockCache),
    getConfig: vi.fn(() => ({ systemPrompt: "test prompt" })),
    list: vi.fn(() => []),
    update: vi.fn(),
    delete: vi.fn(),
    getPrompt: vi.fn(),
    updatePrompt: vi.fn(),
    reloadWorkspace: vi.fn(),
  } as unknown as DefaultAgentManager;
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
    setMessages: vi.fn(),
    setMetadata: vi.fn(),
    getSessionManager: vi.fn().mockResolvedValue({
      loadMessages: vi.fn().mockReturnValue([]),
      appendMessage: vi.fn(),
    }),
  };
}
