import type { ChannelAdapter, ChannelAdapterDeps } from "../../channels/types.js";
import { createDiscordChannel } from "../../channels/discord/index.js";

export interface LoadChannelsResult {
  stopAll(): Promise<void>;
}

export interface LoadChannelsDeps extends ChannelAdapterDeps {
  config: { channels?: Record<string, unknown> };
}

export async function loadChannels(deps: LoadChannelsDeps): Promise<LoadChannelsResult> {
  const adapters: ChannelAdapter[] = [];

  if (deps.config.channels?.discord) {
    adapters.push(createDiscordChannel(deps.config.channels.discord));
  }

  await Promise.all(adapters.map((a) => a.start(deps)));

  return {
    async stopAll() {
      await Promise.all(adapters.map((a) => a.stop()));
    },
  };
}
