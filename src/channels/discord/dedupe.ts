export interface DedupeCacheOptions {
  /** Default: 5 minutes. */
  ttlMs?: number;
  /** Default: 5000. */
  maxSize?: number;
}

/**
 * TTL-based dedupe with lazy eviction (no timers; cleanup on insertion).
 * Prevents duplicate processing when channel gateways replay messages
 * (e.g. Discord reconnect resends).
 *
 * Channels build the key from their own identifiers:
 * - Discord: `${botId}:${channelId}:${messageId}`
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
   * Returns true if the key has been seen recently.
   * Returns false and **records the key** if it's new or expired.
   */
  isDuplicate(key: string): boolean {
    const now = Date.now();
    const existing = this.cache.get(key);

    if (existing !== undefined && now - existing < this.ttlMs) {
      return true;
    }

    this.cache.delete(key); // re-insert for LRU ordering
    this.cache.set(key, now);
    this.prune(now);
    return false;
  }

  get size(): number {
    return this.cache.size;
  }

  /** Like isDuplicate but doesn't record — gate expensive work before the real check. */
  peek(key: string): boolean {
    const existing = this.cache.get(key);
    return existing !== undefined && Date.now() - existing < this.ttlMs;
  }

  clear(): void {
    this.cache.clear();
  }

  /** Remove expired entries, then evict oldest if still over maxSize. */
  private prune(now: number): void {
    for (const [key, ts] of this.cache) {
      if (now - ts >= this.ttlMs) {
        this.cache.delete(key);
      } else {
        break; // Map is insertion-ordered — once we hit a non-expired entry, the rest are newer.
      }
    }

    while (this.cache.size > this.maxSize) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
  }
}
