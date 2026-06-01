import type { Channel, ChannelHistoryEntry, ChannelTarget, MessagingChannel } from "./types.js";
import { isMessagingChannel } from "./types.js";

/**
 * Single outbound facade for cron, heartbeat, and agent tools. Dispatches a
 * ChannelTarget to the right MessagingChannel adapter by `type`.
 */
export class ChannelRouter {
  private channels = new Map<string, MessagingChannel>();

  register(channels: Iterable<Channel>): void {
    for (const c of channels) {
      if (!isMessagingChannel(c)) continue;
      if (this.channels.has(c.kind)) {
        throw new Error(`ChannelRouter: duplicate channel kind "${c.kind}"`);
      }
      this.channels.set(c.kind, c);
    }
  }

  has(type: string): boolean {
    return this.channels.has(type);
  }

  async send(target: ChannelTarget, content: string): Promise<{ id: string }> {
    return this.channelFor(target).send(target, content);
  }

  async fetchHistory(target: ChannelTarget, opts: { limit: number }): Promise<ChannelHistoryEntry[]> {
    return this.channelFor(target).fetchHistory(target, opts);
  }

  private channelFor(t: ChannelTarget): MessagingChannel {
    const c = this.channels.get(t.type);
    if (!c) throw new Error(`No channel registered for type "${t.type}"`);
    return c;
  }
}
