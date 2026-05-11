import type { ClientLike } from "./index.js";

/**
 * Add a reaction. Tries channelId fast-path then scans the given clients'
 * caches. Caller decides which clients are eligible — pass a single-element
 * array to scope to one bot (per-agent binding).
 */
export async function reactToMessage(
  clients: ClientLike[],
  messageId: string,
  emoji: string,
  channelId?: string,
): Promise<void> {
  for (const client of clients) {
    if (channelId) {
      try {
        const channel = (await client.channels.fetch(channelId)) as
          | { messages?: { fetch: (id: string) => Promise<{ react: (e: string) => Promise<unknown> }> } }
          | null;
        const target = await channel?.messages?.fetch(messageId);
        if (target) {
          await target.react(emoji);
          return;
        }
      } catch { /* try slow path */ }
    }

    for (const ch of client.channels.cache.values()) {
      const messages = (ch as { messages?: { fetch: (id: string) => Promise<{ react: (e: string) => Promise<unknown> }> } }).messages;
      if (!messages) continue;
      try {
        const target = await messages.fetch(messageId);
        if (target) {
          await target.react(emoji);
          return;
        }
      } catch { /* not in this channel */ }
    }
  }
  throw new Error(`Message not found: ${messageId}`);
}
