// src/core/dedupe.ts — TTL-based message deduplication cache.
// Lazy eviction (no timers) — cleanup runs on insertion.

export interface DedupeCacheOptions {
  /** TTL in milliseconds. Default: 300_000 (5 minutes) */
  ttlMs?: number;
  /** Maximum entries before oldest are evicted. Default: 5000 */
  maxSize?: number;
}

/**
 * Prevents duplicate message processing when transport gateways deliver
 * the same message more than once (e.g. Discord reconnect replays).
 *
 * Transports build the key from their own identifiers:
 * - Discord: `${botId}:${channelId}:${messageId}`
 * - Feishu:  `${appId}:${chatId}:${messageId}`
 */
export class DedupeCache {
  private cache = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(opts?: DedupeCacheOptions) {
    this.ttlMs = opts?.ttlMs ?? 300_000;
    this.maxSize = opts?.maxSize ?? 5000;
  }

  /**
   * Check if a key has been seen recently.
   * Returns `true` if duplicate (already seen and not expired).
   * Returns `false` and records the key if it's new or expired.
   */
  isDuplicate(key: string): boolean {
    const now = Date.now();
    const existing = this.cache.get(key);

    if (existing !== undefined && now - existing < this.ttlMs) {
      return true;
    }

    // Record as new (or refresh expired)
    this.cache.delete(key); // re-insert for LRU ordering
    this.cache.set(key, now);
    this.prune(now);
    return false;
  }

  /** Number of keys currently tracked. */
  get size(): number {
    return this.cache.size;
  }

  /** Remove expired entries, then evict oldest if still over maxSize. */
  private prune(now: number): void {
    // Remove expired
    for (const [key, ts] of this.cache) {
      if (now - ts >= this.ttlMs) {
        this.cache.delete(key);
      } else {
        break; // Map is ordered by insertion — once we hit a non-expired entry, the rest are newer
      }
    }

    // Evict oldest if still over capacity
    while (this.cache.size > this.maxSize) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
  }
}
