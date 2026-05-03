// src/plugins/discord/a2a-stream-context.ts
//
// AsyncLocalStorage that the Discord transport sets while driving the parent
// agent loop. The in-agent `call_agent` tool reads this context to decide
// whether to stream a sub-run's intermediate output to a dedicated Discord
// thread (and to register the (threadId → runId) mapping that lets the
// transport route a `/stop` posted in that thread back to runtime.cancel).

import { AsyncLocalStorage } from "node:async_hooks";

export interface DiscordChannelMinimalApi {
  /** Send a message to a channel/thread. Returns the new message id. */
  sendMessage(channelId: string, content: string): Promise<{ id: string }>;
  /** Create a thread under `parentChannelId` rooted at `messageId`. */
  createThread(parentChannelId: string, name: string, messageId: string): Promise<{ id: string }>;
}

export interface DiscordA2AStreamContext extends DiscordChannelMinimalApi {
  /** The Discord channel where the parent agent is currently replying. New
   * sub-run threads will be created in (or relative to) this channel. */
  parentChannelId: string;
  /** Whether to surface tool_call events as 🔧 markers in the thread. */
  showToolCalls?: boolean;
  /** Called by the sink as soon as the sub-run thread is created. */
  registerA2AThread(threadId: string, runId: string): void;
  /** Called by the sink when the sub-run completes (success or failure). */
  unregisterA2AThread(threadId: string): void;
}

const storage = new AsyncLocalStorage<DiscordA2AStreamContext>();

export function runWithDiscordA2AStream<T>(
  ctx: DiscordA2AStreamContext,
  fn: () => T,
): T {
  return storage.run(ctx, fn);
}

export function getDiscordA2AStreamContext(): DiscordA2AStreamContext | undefined {
  return storage.getStore();
}
