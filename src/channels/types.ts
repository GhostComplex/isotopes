// src/channels/types.ts — ChannelAdapter contract.
//
// A ChannelAdapter is a transport-side integration (Discord, Feishu, …) that
// owns its connection lifecycle and pushes messages into the gateway.
//
// The contract is deliberately minimal: each adapter narrows its own config
// section internally; the channel loader passes the raw value through.

import type { Gateway } from "../gateway/index.js";
import type { Logger } from "../logging/logger.js";

export interface ChannelAdapterDeps {
  gateway: Gateway;
  /** Adapter-specific config section. The adapter narrows this itself. */
  config: unknown;
  logger: Logger;
}

export interface ChannelAdapter {
  start(deps: ChannelAdapterDeps): Promise<void>;
  stop(): Promise<void>;
}
