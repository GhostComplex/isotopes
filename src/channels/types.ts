import type { Gateway } from "../gateway/index.js";
import type { Logger } from "../logging/logger.js";
import type { LazyChannelContext } from "./channel-context.js";

export interface ChannelAdapterDeps {
  gateway: Gateway;
  logger: Logger;
  /** Per-agent contexts the adapter binds to so agent tools can call back. */
  channelContexts?: Map<string, LazyChannelContext>;
}

export interface ChannelAdapter {
  start(deps: ChannelAdapterDeps): Promise<void>;
  stop(): Promise<void>;
}

export type ChannelsConfig = Record<string, unknown>;

/** Callback surface a channel exposes to agent tools (via LazyChannelContext). */
export interface Channel {
  react?(messageId: string, emoji: string, channelId?: string): Promise<void>;
}
