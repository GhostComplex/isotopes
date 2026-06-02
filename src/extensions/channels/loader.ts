import type { Channel, ChannelDeps } from "../../channels/types.js";
import { createDiscordChannel, type DiscordChannel } from "../../channels/discord/index.js";
import { createLogger } from "../../logging/logger.js";

const log = createLogger("channel-manager");

export class ChannelManager {
  private channels: Channel[] = [];
  private running = false;
  private readonly config: { channels?: Record<string, unknown> };
  /** Direct handle to the Discord adapter; used by the scheduled-job pipeline. */
  discord?: DiscordChannel;

  constructor(config: { channels?: Record<string, unknown> }) {
    this.config = config;
  }

  async start(deps: ChannelDeps): Promise<void> {
    if (this.running) return;

    if (this.config.channels?.discord) {
      const discord = createDiscordChannel(this.config.channels.discord);
      this.discord = discord;
      this.channels.push(discord);
    }

    await Promise.all(this.channels.map((c) => c.start(deps)));
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    await Promise.all(this.channels.map(async (c) => {
      try {
        await c.stop();
      } catch (err) {
        log.warn("Channel stop failed", { error: err });
      }
    }));
    this.running = false;
  }
}
