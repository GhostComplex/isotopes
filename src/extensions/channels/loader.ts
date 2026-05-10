import type { Channel, ChannelDeps } from "../../channels/types.js";
import { createDiscordChannel } from "../../channels/discord/index.js";

export interface LoadChannelsResult {
  stopAll(): Promise<void>;
}

export interface LoadChannelsDeps extends ChannelDeps {
  config: { channels?: Record<string, unknown> };
}

export async function loadChannels(deps: LoadChannelsDeps): Promise<LoadChannelsResult> {
  const channels: Channel[] = [];

  if (deps.config.channels?.discord) {
    channels.push(createDiscordChannel(deps.config.channels.discord));
  }

  await Promise.all(channels.map((c) => c.start(deps)));

  return {
    async stopAll() {
      await Promise.all(channels.map((c) => c.stop()));
    },
  };
}
