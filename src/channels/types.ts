import type { Gateway } from "../gateway/index.js";

export interface Channel {
  start(deps: ChannelDeps): Promise<void>;
  stop(): Promise<void>;
}

export interface ChannelDeps {
  gateway: Gateway;
  /** Per-agent contexts the channel binds to so agent tools can call back. */
  channelContexts?: Map<string, LazyChannelContext>;
}

/** Actions an agent tool can perform on the channel (via LazyChannelContext). */
export interface ChannelActions {
  react?(messageId: string, emoji: string, channelId: string): Promise<void>;
  sendMessage?(channelId: string, content: string): Promise<{ id: string }>;
}

export type ChannelsConfig = Record<string, unknown>;

export interface ChannelContext {
  getChannelActions(): ChannelActions | undefined;
}

/** Late-binding so agent tools can be constructed before channels start. */
export class LazyChannelContext implements ChannelContext {
  private actions: ChannelActions | undefined;
  setChannelActions(actions: ChannelActions): void { this.actions = actions; }
  getChannelActions(): ChannelActions | undefined { return this.actions; }
}
