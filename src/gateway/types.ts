// src/gateway/types.ts — Gateway types (routing decisions + transport contract)

// ---------------------------------------------------------------------------
// Bindings — route messages to agents by (channel, accountId, peer)
// ---------------------------------------------------------------------------

/** Peer kind: group channel, direct message, or thread */
export type PeerKind = 'group' | 'dm' | 'thread';

/** Peer identifier — a specific chat target within a channel+account */
export interface BindingPeer {
  kind: PeerKind;
  id: string;
}

/** Match criteria for a binding rule */
export interface BindingMatch {
  /** Transport channel type (e.g. "discord") */
  channel: string;
  /** Account identifier within that channel */
  accountId?: string;
  /** Specific peer (group/dm/thread) to scope the binding */
  peer?: BindingPeer;
}

/** A binding ties an agent to a (channel, accountId, peer) pattern */
export interface Binding {
  agentId: string;
  match: BindingMatch;
}

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
