import type { ClientLike } from "./index.js";

/** Add an emoji reaction. Caller must know the channelId — no cache scan. */
export async function react(
  client: ClientLike,
  messageId: string,
  emoji: string,
  channelId: string,
): Promise<void> {
  const channel = (await client.channels.fetch(channelId)) as
    | { messages?: { fetch: (id: string) => Promise<{ react: (e: string) => Promise<unknown> }> } }
    | null;
  const target = await channel?.messages?.fetch(messageId);
  if (!target) throw new Error(`Message ${messageId} not found in channel ${channelId}`);
  await target.react(emoji);
}
