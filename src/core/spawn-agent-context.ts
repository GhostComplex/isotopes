// src/core/spawn-agent-context.ts — AsyncLocalStorage context for agent spawn streaming
// Provides a way to pass transport-specific streaming context to spawn tool handlers.

import { AsyncLocalStorage } from "node:async_hooks";
import type { RunEvent, RunResult } from "../agents/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Transport-agnostic sink for streaming spawn agent events.
 * Each transport (Discord, Slack, etc.) implements this interface to
 * stream spawn agent output to its channel.
 */
export interface SpawnAgentStreamSink {
  start(taskLabel: string): Promise<void>;
  sendEvent(event: RunEvent): Promise<void>;
  finish(result: RunResult): Promise<void>;
  getThreadId?(): string | undefined;
}

/**
 * Context for spawn agent streaming, passed via AsyncLocalStorage.
 * When present, the spawn agent tool handler will stream output through the sink.
 */
export interface SpawnAgentStreamContext {
  createSink(channelId: string, config: { showToolCalls: boolean; useThread: boolean }): SpawnAgentStreamSink;
  channelId: string;
  sessionId?: string;
  showToolCalls?: boolean;
  onComplete?: (threadId: string) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage
// ---------------------------------------------------------------------------

const spawnAgentContextStorage = new AsyncLocalStorage<SpawnAgentStreamContext>();

export function runWithSpawnAgentContext<T>(
  context: SpawnAgentStreamContext,
  fn: () => T,
): T {
  return spawnAgentContextStorage.run(context, fn);
}

export async function runWithSpawnAgentContextAsync<T>(
  context: SpawnAgentStreamContext,
  fn: () => Promise<T>,
): Promise<T> {
  return spawnAgentContextStorage.run(context, fn);
}

export function getSpawnAgentContext(): SpawnAgentStreamContext | undefined {
  return spawnAgentContextStorage.getStore();
}

export function hasSpawnAgentContext(): boolean {
  return spawnAgentContextStorage.getStore() !== undefined;
}
