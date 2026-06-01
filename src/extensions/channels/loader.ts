import type { Channel, ChannelDeps } from "../../channels/types.js";
import { ChannelRouter } from "../../channels/router.js";
import { createDiscordChannel } from "../../channels/discord/index.js";
import { createLogger } from "../../logging/logger.js";

const log = createLogger("channel-manager");

export class ChannelManager {
  private channels: Channel[] = [];
  private running = false;
  private readonly config: { channels?: Record<string, unknown> };
  readonly router = new ChannelRouter();

  constructor(config: { channels?: Record<string, unknown> }) {
    this.config = config;
  }

  async start(deps: ChannelDeps): Promise<void> {
    if (this.running) return;

    if (this.config.channels?.discord) {
      this.channels.push(createDiscordChannel(this.config.channels.discord));
    }

    await Promise.all(this.channels.map((c) => c.start(deps)));
    this.router.register(this.channels);

    // After per-channel adapters bound their own actions (react, etc.) into
    // each LazyChannelContext, decorate them with router-backed send/fetchHistory
    // so the message tool can address any channel without knowing the kind.
    if (deps.channelContexts) {
      const router = this.router;
      for (const ctx of deps.channelContexts.values()) {
        const existing = ctx.getChannelActions() ?? {};
        ctx.setChannelActions({
          ...existing,
          send: (target, content) => router.send(target, content),
          fetchHistory: (target, opts) => router.fetchHistory(target, opts),
        });
      }
    }

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
