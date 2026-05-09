// src/gateway/types.ts — Gateway types (channels config + channel contract)

// ---------------------------------------------------------------------------
// Channel config — extensible per-channel
// ---------------------------------------------------------------------------

/** Channels section of the configuration — keyed by channel name */
export type ChannelsConfig = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

/** Lifecycle interface for a message channel (Discord, etc.). */
export interface Channel {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Reply to a specific message by ID. If channelId is provided, skip O(n) channel scan. */
  reply?(messageId: string, content: string, channelId?: string, attachments?: Array<{ buffer: Buffer; name: string }>): Promise<{ messageId: string }>;
  /** Add a reaction emoji to a specific message by ID. If channelId is provided, skip O(n) channel scan. */
  react?(messageId: string, emoji: string, channelId?: string): Promise<void>;
}
