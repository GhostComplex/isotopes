// src/gateway/types.ts — Gateway types (channels config + transport contract)

// ---------------------------------------------------------------------------
// Channel config — extensible per-transport
// ---------------------------------------------------------------------------

/** Channels section of the configuration — keyed by transport name */
export type ChannelsConfig = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Lifecycle interface for a message transport (Discord, etc.). */
export interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Reply to a specific message by ID. If channelId is provided, skip O(n) channel scan. */
  reply?(messageId: string, content: string, channelId?: string, attachments?: Array<{ buffer: Buffer; name: string }>): Promise<{ messageId: string }>;
  /** Add a reaction emoji to a specific message by ID. If channelId is provided, skip O(n) channel scan. */
  react?(messageId: string, emoji: string, channelId?: string): Promise<void>;
}
