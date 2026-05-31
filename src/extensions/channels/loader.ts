import type { Channel, ChannelDeps } from "../../channels/types.js";
import { createDiscordChannel } from "../../channels/discord/index.js";

export class ChannelManager {
  private channels: Channel[] = [];
  private readonly config: { channels?: Record<string, unknown> };

  constructor(config: { channels?: Record<string, unknown> }) {
    this.config = config;
  }

  async start(deps: ChannelDeps): Promise<void> {
    if (this.config.channels?.discord) {
      this.channels.push(createDiscordChannel(this.config.channels.discord));
    }

    await Promise.all(this.channels.map((c) => c.start(deps)));
  }

  async stop(): Promise<void> {
    await Promise.all(this.channels.map((c) => c.stop()));
  }
}
