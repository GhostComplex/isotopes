/** FIFO per key; different keys run concurrently. */
export class KeyedAsyncQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.then(task);
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

  has(key: string): boolean {
    return this.tails.has(key);
  }

  /** Drop bookkeeping; in-flight tasks keep running. */
  clear(): void {
    this.tails.clear();
  }
}
