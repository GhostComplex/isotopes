import type { Channel, ChannelDeps, NotificationTarget } from "../../channels/types.js";
import { createDiscordChannel } from "../../channels/discord/index.js";
import { createLogger } from "../../logging/logger.js";

const log = createLogger("channel-manager");

export class ChannelManager {
  private channels: Channel[] = [];
  private running = false;
  private readonly config: { channels?: Record<string, unknown> };

  constructor(config: { channels?: Record<string, unknown> }) {
    this.config = config;
  }

  async start(deps: ChannelDeps): Promise<void> {
    if (this.running) return;

    if (this.config.channels?.discord) {
      this.channels.push(createDiscordChannel(this.config.channels.discord));
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

  async notify(target: NotificationTarget, content: string): Promise<void> {
    await Promise.all(this.channels.map((c) => c.notify?.(target, content)));
  }
}
