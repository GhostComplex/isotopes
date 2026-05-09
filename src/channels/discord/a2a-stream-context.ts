// ALS-propagated handle that lets `spawn_agent`, running deep inside the
// agent loop, surface a sub-run in a Discord thread without taking a hard
// dependency on the channel adapter.

import { AsyncLocalStorage } from "node:async_hooks";

export interface DiscordChannelMinimalApi {
  sendMessage(channelId: string, content: string): Promise<{ id: string }>;
  createThread(parentChannelId: string, name: string, messageId: string): Promise<{ id: string }>;
}

export interface DiscordA2AStreamContext extends DiscordChannelMinimalApi {
  parentChannelId: string;
  showToolCalls?: boolean;
  registerA2AThread(threadId: string, sessionId: string): void;
  unregisterA2AThread(threadId: string): void;
}

const storage = new AsyncLocalStorage<DiscordA2AStreamContext>();

export function runWithDiscordA2AStream<T>(ctx: DiscordA2AStreamContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getDiscordA2AStreamContext(): DiscordA2AStreamContext | undefined {
  return storage.getStore();
}
