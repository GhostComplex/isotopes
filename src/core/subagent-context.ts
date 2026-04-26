// src/core/subagent-context.ts — AsyncLocalStorage context for subagent streaming
// Provides a way to pass transport-specific streaming context to subagent tool handlers.

import { AsyncLocalStorage } from "node:async_hooks";
import type { RunEvent, RunResult } from "../agents/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Transport-agnostic sink for streaming subagent events.
 * Each transport (Discord, Slack, etc.) implements this interface to
 * stream subagent output to its channel.
 */
export interface SubagentStreamSink {
  start(taskLabel: string): Promise<void>;
  sendEvent(event: RunEvent): Promise<void>;
  finish(result: RunResult): Promise<void>;
  getThreadId?(): string | undefined;
}

/**
 * Context for subagent streaming, passed via AsyncLocalStorage.
 * When present, the subagent tool handler will stream output through the sink.
 */
export interface SubagentStreamContext {
  createSink(channelId: string, config: { showToolCalls: boolean; useThread: boolean }): SubagentStreamSink;
  channelId: string;
  sessionId?: string;
  showToolCalls?: boolean;
  onComplete?: (threadId: string) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage
// ---------------------------------------------------------------------------

const subagentContextStorage = new AsyncLocalStorage<SubagentStreamContext>();

export function runWithSubagentContext<T>(
  context: SubagentStreamContext,
  fn: () => T,
): T {
  return subagentContextStorage.run(context, fn);
}

export async function runWithSubagentContextAsync<T>(
  context: SubagentStreamContext,
  fn: () => Promise<T>,
): Promise<T> {
  return subagentContextStorage.run(context, fn);
}

export function getSubagentContext(): SubagentStreamContext | undefined {
  return subagentContextStorage.getStore();
}

export function hasSubagentContext(): boolean {
  return subagentContextStorage.getStore() !== undefined;
}
