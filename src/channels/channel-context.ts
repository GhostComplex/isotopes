import type { ChannelActions } from "./types.js";

export interface ChannelContext {
  getChannelActions(): ChannelActions | undefined;
}

/** Late-binding so agent tools can be constructed before channels start. */
export class LazyChannelContext implements ChannelContext {
  private actions: ChannelActions | undefined;
  setChannelActions(actions: ChannelActions): void { this.actions = actions; }
  getChannelActions(): ChannelActions | undefined { return this.actions; }
}
