/**
 * Serialize async work per key while unrelated keys run concurrently.
 *
 * Used by channels to make "at most one inbound run per session" a structural
 * invariant rather than a coordinated protocol — concurrent enqueues for the
 * same key chain into a FIFO; different keys are independent.
 */
export class KeyedAsyncQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    const cleanup = () => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
    tail.then(cleanup, cleanup);
    return current;
  }

  /** True if any task for `key` is queued or running. Test/debug helper. */
  has(key: string): boolean {
    return this.tails.has(key);
  }

  /** Clear the tail map. In-flight tasks keep running; only releases bookkeeping. */
  clear(): void {
    this.tails.clear();
  }
}
