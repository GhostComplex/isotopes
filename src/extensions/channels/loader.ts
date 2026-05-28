import type { Channel, ChannelDeps } from "../../channels/types.js";
import { createDiscordChannel } from "../../channels/discord/index.js";

export interface StartChannelsResult {
  stop(): Promise<void>;
}

export interface StartChannelsDeps extends ChannelDeps {
  config: { channels?: Record<string, unknown> };
}

export async function startChannels(deps: StartChannelsDeps): Promise<StartChannelsResult> {
  const channels: Channel[] = [];

  if (deps.config.channels?.discord) {
    channels.push(createDiscordChannel(deps.config.channels.discord));
  }

  await Promise.all(channels.map((c) => c.start(deps)));

  return {
    async stop() {
      await Promise.all(channels.map((c) => c.stop()));
    },
  };
}
