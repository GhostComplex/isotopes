import type { Gateway } from "../gateway/index.js";
import type { Logger } from "../logging/logger.js";
import type { LazyChannelContext } from "./channel-context.js";

export interface ChannelDeps {
  gateway: Gateway;
  logger: Logger;
  /** Per-agent contexts the channel binds to so agent tools can call back. */
  channelContexts?: Map<string, LazyChannelContext>;
}

export interface Channel {
  start(deps: ChannelDeps): Promise<void>;
  stop(): Promise<void>;
}

export type ChannelsConfig = Record<string, unknown>;

/** Actions an agent tool can perform on the channel (via LazyChannelContext). */
export interface ChannelActions {
  react?(messageId: string, emoji: string, channelId?: string): Promise<void>;
}
