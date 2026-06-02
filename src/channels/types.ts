import type { Gateway } from "../gateway/index.js";

/** Addresses a destination on any channel adapter. */
export interface ChannelTarget {
  accountId: string;
  channelId: string;
  threadId?: string;
}

/** One message returned by `Channel.fetchHistory`. */
export interface ChannelHistoryEntry {
  messageId: string;
  sender: string;
  body: string;
  /** Epoch ms. */
  timestamp: number;
}

export interface Channel {
  /** Channel kind, e.g. "discord". */
  kind: string;
  start(deps: ChannelDeps): Promise<void>;
  stop(): Promise<void>;
  send(target: ChannelTarget, content: string): Promise<{ id: string }>;
  fetchHistory(target: ChannelTarget, opts: { limit: number }): Promise<ChannelHistoryEntry[]>;
}

export interface ChannelDeps {
  gateway: Gateway;
  /** Per-agent contexts the channel binds to so agent tools can call back. */
  channelContexts?: Map<string, LazyChannelContext>;
}

/** Actions an agent tool can perform on the channel (via LazyChannelContext). */
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
