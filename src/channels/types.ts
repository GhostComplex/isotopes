// src/channels/types.ts — Channel adapter contracts.
//
// A ChannelAdapter is a channel-side integration (Discord, Feishu, …) that
// owns its connection lifecycle and pushes messages into the gateway.
//
// The contract is deliberately minimal: each adapter narrows its own config
// section internally; the channel loader passes the raw value through.

import type { Gateway } from "../gateway/index.js";
import type { Logger } from "../logging/logger.js";
import type { LazyChannelContext } from "./channel-context.js";

export interface ChannelAdapterDeps {
  gateway: Gateway;
  /** Adapter-specific config section. The adapter narrows this itself. */
  config: unknown;
  logger: Logger;
  /**
   * Per-agent channel contexts the adapter binds itself to so agent tools
   * (e.g. `message_react`) can call back into the channel. Optional — channels
   * without callback capability ignore this.
   */
  channelContexts?: Map<string, LazyChannelContext>;
}

export interface ChannelAdapter {
  start(deps: ChannelAdapterDeps): Promise<void>;
  stop(): Promise<void>;
}

/** Config slot — `config.channels.<name>` is opaque to everything but the adapter. */
export type ChannelsConfig = Record<string, unknown>;

/**
 * Callback surface a channel adapter exposes to agent tools (via
 * LazyChannelContext) — currently `message_react` and the unused `reply`
 * primitive. Distinct from ChannelAdapter (which owns lifecycle).
 */
export interface Channel {
  reply?(messageId: string, content: string, channelId?: string, attachments?: Array<{ buffer: Buffer; name: string }>): Promise<{ messageId: string }>;
  react?(messageId: string, emoji: string, channelId?: string): Promise<void>;
}
