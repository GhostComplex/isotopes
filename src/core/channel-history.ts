// src/core/channel-history.ts — Transport-agnostic channel history buffer.
// Records messages the bot observes but doesn't respond to, then injects
// them as context when the bot IS triggered.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
}

export interface ChannelHistoryBufferOptions {
  /** Max entries per channel. Default: 20 */
  maxEntriesPerChannel?: number;
  /** Max channels tracked (LRU eviction). Default: 1000 */
  maxChannels?: number;
}

// ---------------------------------------------------------------------------
// ChannelHistoryBuffer
// ---------------------------------------------------------------------------

/**
 * In-memory buffer for channel messages the bot observed but did not respond to.
 *
 * - Per-channel FIFO with configurable depth
 * - LRU eviction when channel count exceeds max
 * - Entries are ephemeral — they do NOT go into the session store
 */
export class ChannelHistoryBuffer {
  private entries = new Map<string, HistoryEntry[]>();
  private readonly maxPerChannel: number;
  private readonly maxChannels: number;

  constructor(opts?: ChannelHistoryBufferOptions) {
    this.maxPerChannel = opts?.maxEntriesPerChannel ?? 20;
    this.maxChannels = opts?.maxChannels ?? 1000;
  }

  /** Record a message the bot observed but did not respond to. */
  append(channelKey: string, entry: HistoryEntry): void {
    let list = this.entries.get(channelKey);
    if (list) {
      // Refresh LRU position: delete and re-insert moves to end of iteration order
      this.entries.delete(channelKey);
    } else {
      list = [];
    }

    list.push(entry);
    // FIFO: drop oldest when over limit
    while (list.length > this.maxPerChannel) {
      list.shift();
    }

    this.entries.set(channelKey, list);
    this.evict();
  }

  /** Return accumulated entries and clear them. Used when the bot replies. */
  consumeAndClear(channelKey: string): HistoryEntry[] {
    const list = this.entries.get(channelKey);
    if (!list || list.length === 0) return [];
    this.entries.delete(channelKey);
    return list;
  }

  /** Peek at entries without clearing (for debugging/testing). */
  peek(channelKey: string): readonly HistoryEntry[] {
    return this.entries.get(channelKey) ?? [];
  }

  /** Explicitly clear entries for a channel. */
  clear(channelKey: string): void {
    this.entries.delete(channelKey);
  }

  /** Number of channels currently tracked. */
  get size(): number {
    return this.entries.size;
  }

  /** LRU eviction — remove oldest channels when over capacity. */
  private evict(): void {
    while (this.entries.size > this.maxChannels) {
      // Map iteration order is insertion order — first key is oldest
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------------------
// buildHistoryContext — format entries into enriched user message text
// ---------------------------------------------------------------------------

const HISTORY_MARKER = "[Chat messages since your last reply - for context]";
const CURRENT_MARKER = "[Current message - respond to this]";

/**
 * Format channel history entries into a context string prepended to the
 * user's actual message.
 *
 * If there are no entries, returns `currentMessage` unchanged.
 */
export function buildHistoryContext(
  entries: HistoryEntry[],
  currentMessage: string,
): string {
  if (entries.length === 0) return currentMessage;

  const lines = entries.map((e) => `${e.sender}: ${e.body}`);
  return `${HISTORY_MARKER}\n${lines.join("\n")}\n\n${CURRENT_MARKER}\n${currentMessage}`;
}
