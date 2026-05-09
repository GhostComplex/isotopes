import type { Channel } from "./types.js";

export interface ChannelContext {
  getChannel(): Channel | undefined;
}

/** Late-binding — tools are constructed before channels start. */
export class LazyChannelContext implements ChannelContext {
  private channel: Channel | undefined;
  setChannel(channel: Channel): void { this.channel = channel; }
  getChannel(): Channel | undefined { return this.channel; }
}
