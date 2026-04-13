// src/core/debounce.ts — Combine rapid-fire messages from the same user
// into a single prompt. Opt-in feature (default disabled in config).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DebouncedMessage {
  /** Combined text (messages joined with \n) */
  text: string;
  /** All individual message IDs in order */
  messageIds: string[];
  /** Timestamp of the first message */
  firstTimestamp: number;
  /** Timestamp of the last message */
  lastTimestamp: number;
  /** Metadata from the first message */
  metadata: Record<string, unknown>;
}

export interface InboundDebouncerOptions {
  /** Debounce window in milliseconds. Default: 1500 */
  windowMs?: number;
}

// ---------------------------------------------------------------------------
// Internal buffer
// ---------------------------------------------------------------------------

interface PendingBuffer {
  texts: string[];
  messageIds: string[];
  firstTimestamp: number;
  lastTimestamp: number;
  metadata: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout>;
  /** Resolve for the primary (first) caller */
  primaryResolve: (result: DebouncedMessage | null) => void;
  /** Resolves for secondary callers — they get null */
  secondaryResolves: Array<(result: null) => void>;
}

// ---------------------------------------------------------------------------
// InboundDebouncer
// ---------------------------------------------------------------------------

/**
 * Combines rapid-fire messages from the same user in the same channel
 * into a single debounced message.
 *
 * Key composition by transport:
 * - Discord: `discord:${channelId}:${authorId}`
 * - Feishu:  `feishu:${chatId}:${userId}`
 */
export class InboundDebouncer {
  private buffers = new Map<string, PendingBuffer>();
  private readonly windowMs: number;

  constructor(opts?: InboundDebouncerOptions) {
    this.windowMs = opts?.windowMs ?? 1500;
  }

  /**
   * Submit a message for debouncing.
   *
   * Returns a Promise that resolves to:
   * - `DebouncedMessage` for the primary (first) caller
   * - `null` for secondary callers (they should return early)
   */
  submit(
    key: string,
    text: string,
    messageId: string,
    timestamp: number,
    metadata?: Record<string, unknown>,
  ): Promise<DebouncedMessage | null> {
    const existing = this.buffers.get(key);

    if (existing) {
      // Extend existing buffer
      existing.texts.push(text);
      existing.messageIds.push(messageId);
      existing.lastTimestamp = timestamp;

      // Reset timer
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.flush(key), this.windowMs);

      // Secondary caller gets null
      return new Promise<null>((resolve) => {
        existing.secondaryResolves.push(resolve);
      });
    }

    // Primary caller — create new buffer
    return new Promise<DebouncedMessage | null>((resolve) => {
      const buffer: PendingBuffer = {
        texts: [text],
        messageIds: [messageId],
        firstTimestamp: timestamp,
        lastTimestamp: timestamp,
        metadata: metadata ?? {},
        timer: setTimeout(() => this.flush(key), this.windowMs),
        primaryResolve: resolve,
        secondaryResolves: [],
      };
      this.buffers.set(key, buffer);
    });
  }

  /** Cancel a pending debounce for a key. */
  cancel(key: string): void {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    clearTimeout(buffer.timer);
    // Resolve all waiters with null to unblock them
    buffer.primaryResolve(null);
    for (const resolve of buffer.secondaryResolves) {
      resolve(null);
    }
    this.buffers.delete(key);
  }

  /** Number of keys with pending debounce timers. */
  get pendingCount(): number {
    return this.buffers.size;
  }

  /** Cancel all pending timers (call on transport shutdown). */
  dispose(): void {
    for (const key of [...this.buffers.keys()]) {
      this.cancel(key);
    }
  }

  private flush(key: string): void {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    this.buffers.delete(key);

    const result: DebouncedMessage = {
      text: buffer.texts.join("\n"),
      messageIds: buffer.messageIds,
      firstTimestamp: buffer.firstTimestamp,
      lastTimestamp: buffer.lastTimestamp,
      metadata: buffer.metadata,
    };

    buffer.primaryResolve(result);
    for (const resolve of buffer.secondaryResolves) {
      resolve(null);
    }
  }
}
