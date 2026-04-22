// src/core/subagent-context.ts — AsyncLocalStorage context for subagent Discord integration
// Provides a way to pass Discord channel/thread context to subagent tool handlers.

import { AsyncLocalStorage } from "node:async_hooks";
import type { SendMessageFn, CreateThreadFn } from "../transports/discord-subagent-sink.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Discord context passed to subagent tool handlers.
 * When present, subagent will stream output to a Discord thread.
 */
export interface SubagentDiscordContext {
  /** Function to send a message to Discord */
  sendMessage: SendMessageFn;
  /** Function to create a thread from a message */
  createThread: CreateThreadFn;
  /** Channel ID where the subagent was triggered */
  channelId: string;
  /** Session ID for failure tracking */
  sessionId?: string;
  /** Whether to show tool calls in the thread */
  showToolCalls?: boolean;
  /** Callback invoked when subagent completes (for auto-unbind) */
  onComplete?: (threadId: string) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage
// ---------------------------------------------------------------------------

/** Storage for subagent Discord context */
const subagentContextStorage = new AsyncLocalStorage<SubagentDiscordContext>();

/**
 * Run a function with subagent Discord context.
 * Tool handlers called within this scope can access the context.
 *
 * @param context - Discord context for subagent output
 * @param fn - Function to run with the context
 * @returns Result of the function
 */
export function runWithSubagentContext<T>(
  context: SubagentDiscordContext,
  fn: () => T,
): T {
  return subagentContextStorage.run(context, fn);
}

/**
 * Run an async function with subagent Discord context.
 * Tool handlers called within this scope can access the context.
 *
 * @param context - Discord context for subagent output
 * @param fn - Async function to run with the context
 * @returns Promise resolving to the result of the function
 */
export async function runWithSubagentContextAsync<T>(
  context: SubagentDiscordContext,
  fn: () => Promise<T>,
): Promise<T> {
  return subagentContextStorage.run(context, fn);
}

/**
 * Get the current subagent Discord context, if any.
 * Returns undefined if not running within a Discord-initiated request.
 */
export function getSubagentContext(): SubagentDiscordContext | undefined {
  return subagentContextStorage.getStore();
}

/**
 * Check if subagent Discord context is available.
 */
export function hasSubagentContext(): boolean {
  return subagentContextStorage.getStore() !== undefined;
}
