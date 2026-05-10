const TTL_MS = 5 * 60 * 1000;
const MAX_SIZE = 5000;

/**
 * Lazy eviction (no timers; cleanup on insertion). Used to drop replays from
 * channel gateways (e.g. Discord reconnect resends).
 * Discord key format: `${botId}:${channelId}:${messageId}`.
 */
export class DedupeCache {
  private cache = new Map<string, number>();

  /** Returns true if seen; otherwise **records the key** and returns false. */
  isDuplicate(key: string): boolean {
    const now = Date.now();
    const existing = this.cache.get(key);

    if (existing !== undefined && now - existing < TTL_MS) {
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
    return existing !== undefined && Date.now() - existing < TTL_MS;
  }

  clear(): void {
    this.cache.clear();
  }

  /** Remove expired entries, then evict oldest if still over MAX_SIZE. */
  private prune(now: number): void {
    for (const [key, ts] of this.cache) {
      if (now - ts >= TTL_MS) {
        this.cache.delete(key);
      } else {
        break; // Map is insertion-ordered — once we hit a non-expired entry, the rest are newer.
      }
    }

    while (this.cache.size > MAX_SIZE) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
  }
}
