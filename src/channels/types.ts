import type { Gateway } from "../gateway/index.js";

/** Stable address for a destination on any channel type. */
export interface ChannelTarget {
  /** Channel kind, e.g. "discord". Matched against Channel.kind. */
  type: string;
  /** Optional account id for multi-account setups. */
  accountId?: string;
  channelId: string;
  /** Thread / topic id when the platform supports it. */
  threadId?: string;
}

/** One inbound message as returned by MessagingChannel.fetchHistory. */
export interface ChannelHistoryEntry {
  messageId: string;
  sender: string;
  body: string;
  /** Epoch ms. */
  timestamp: number;
}

export interface Channel {
  /** Channel kind; used by ChannelRouter to dispatch ChannelTarget. */
  kind: string;
  start(deps: ChannelDeps): Promise<void>;
  stop(): Promise<void>;
}

/** Optional capability — channels that can be addressed by ChannelTarget implement this. */
export interface MessagingChannel extends Channel {
  send(target: ChannelTarget, content: string): Promise<{ id: string }>;
  fetchHistory(target: ChannelTarget, opts: { limit: number }): Promise<ChannelHistoryEntry[]>;
}

export function isMessagingChannel(c: Channel): c is MessagingChannel {
  const m = c as Partial<MessagingChannel>;
  return typeof m.send === "function" && typeof m.fetchHistory === "function";
}

export interface ChannelDeps {
  gateway: Gateway;
  /** Per-agent contexts the channel binds to so agent tools can call back. */
  channelContexts?: Map<string, LazyChannelContext>;
}

/** Per-agent actions a tool can perform via its bound channel adapter. */
export interface ChannelActions {
  react?(messageId: string, emoji: string, channelId: string): Promise<void>;
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
