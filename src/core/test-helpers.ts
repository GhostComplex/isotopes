// src/core/test-helpers.ts — Shared test mocks for transport tests
// DRY: both discord.test.ts and feishu.test.ts need identical AgentManager
// and SessionStore mocks. Centralise them here.

import { vi } from "vitest";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { SessionStore } from "./types.js";
import type { PiMonoInstance } from "./pi-mono.js";
import type { DefaultAgentManager } from "./agent-manager.js";

export function createMockAgentInstance(events?: AgentEvent[]): PiMonoInstance {
  const defaultEvents: AgentEvent[] = [
    { type: "message_update", message: {} as never, assistantMessageEvent: { type: "text_delta", delta: "Hello " } as never },
    { type: "message_update", message: {} as never, assistantMessageEvent: { type: "text_delta", delta: "world!" } as never },
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
  } as unknown as PiMonoInstance;
}

export function createMockAgentManager(instance?: PiMonoInstance): DefaultAgentManager {
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
  };
}
