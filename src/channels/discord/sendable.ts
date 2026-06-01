export interface SendableDiscordClient {
  channels: { fetch(id: string): Promise<unknown> };
}

export interface SendableDiscordChannel {
  send(message: string): Promise<unknown>;
}

export async function fetchSendableChannel(
  client: SendableDiscordClient,
  channelId: string,
): Promise<SendableDiscordChannel> {
  const channel = await client.channels.fetch(channelId);
  const sendable = channel as { send?: unknown } | null | undefined;

  if (!sendable || typeof sendable.send !== "function") {
    throw new Error(`Discord channel ${channelId} is not sendable`);
  }

  return sendable as SendableDiscordChannel;
}
