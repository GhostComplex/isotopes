// Per-channel observe buffer: every allowlisted guild msg is appended; on
// dispatch, the buffer is consumed (excluding the trigger msg) and prepended
// to the agent's context. Cleared on consume — semantics are "since last reply",
// so bot doesn't re-see msgs that are already in its session memory.

import type { ChannelHistoryEntry } from "../types.js";

const DEFAULT_LIMIT = 50;
const MAX_KEYS = 1000;

export class ChannelHistoryBuffer {
  private buffers = new Map<string, ChannelHistoryEntry[]>();
  private readonly limit: number;

  constructor(limit = DEFAULT_LIMIT) {
    this.limit = limit;
  }

  append(channelId: string, entry: ChannelHistoryEntry): void {
    const buf = this.buffers.get(channelId) ?? [];
    buf.push(entry);
    while (buf.length > this.limit) buf.shift();
    this.buffers.delete(channelId);
    this.buffers.set(channelId, buf);
    // LRU evict: drop oldest channels when over capacity.
    while (this.buffers.size > MAX_KEYS) {
      const oldest = this.buffers.keys().next().value as string;
      this.buffers.delete(oldest);
    }
  }

  /** Return entries excluding the trigger msg, then clear the key. */
  consumeExcluding(channelId: string, triggerMessageId: string): ChannelHistoryEntry[] {
    const buf = this.buffers.get(channelId) ?? [];
    this.buffers.delete(channelId);
    return buf.filter((e) => e.messageId !== triggerMessageId);
  }

  clear(): void {
    this.buffers.clear();
  }
}

const escape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function formatHistory(entries: ChannelHistoryEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map(
    (e) => `  <msg sender="${escape(e.sender)}" ts="${e.timestamp}">${escape(e.body)}</msg>`,
  );
  return `<channel_history>\n${lines.join("\n")}\n</channel_history>`;
}
