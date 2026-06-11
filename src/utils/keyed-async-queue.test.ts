import { describe, it, expect } from "vitest";
import { KeyedAsyncQueue } from "./keyed-async-queue.js";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("KeyedAsyncQueue", () => {
  it("serializes tasks for the same key", async () => {
    const q = new KeyedAsyncQueue();
    const order: string[] = [];
    const d1 = deferred();
    const d2 = deferred();

    const p1 = q.enqueue("k", async () => {
      order.push("t1:start");
      await d1.promise;
      order.push("t1:end");
    });
    const p2 = q.enqueue("k", async () => {
      order.push("t2:start");
      await d2.promise;
      order.push("t2:end");
    });

    // t2 must not start until t1 finishes.
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(["t1:start"]);

    d1.resolve();
    await p1;
    // Yield once so t2's chained .then(task) fires and t2 enters its body.
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["t1:start", "t1:end", "t2:start"]);

    d2.resolve();
    await p2;
    expect(order).toEqual(["t1:start", "t1:end", "t2:start", "t2:end"]);
  });

  it("runs different keys concurrently", async () => {
    const q = new KeyedAsyncQueue();
    const order: string[] = [];
    const dA = deferred();
    const dB = deferred();

    const pA = q.enqueue("a", async () => {
      order.push("a:start");
      await dA.promise;
      order.push("a:end");
    });
    const pB = q.enqueue("b", async () => {
      order.push("b:start");
      await dB.promise;
      order.push("b:end");
    });

    await new Promise((r) => setTimeout(r, 5));
    // Both started without waiting on each other.
    expect(order).toEqual(["a:start", "b:start"]);

    dB.resolve();
    await pB;
    dA.resolve();
    await pA;
    expect(order.sort()).toEqual(["a:end", "a:start", "b:end", "b:start"]);
  });

  it("returns the task's resolved value", async () => {
    const q = new KeyedAsyncQueue();
    const value = await q.enqueue("k", async () => 42);
    expect(value).toBe(42);
  });

  it("propagates a task error to its caller without breaking the queue", async () => {
    const q = new KeyedAsyncQueue();
    const p1 = q.enqueue("k", async () => {
      throw new Error("boom");
    });
    await expect(p1).rejects.toThrow("boom");

    // Next task on the same key still runs.
    const p2 = q.enqueue("k", async () => "ok");
    expect(await p2).toBe("ok");
  });

  it("cleans up the tail map when a key's chain drains", async () => {
    const q = new KeyedAsyncQueue();
    await q.enqueue("k", async () => undefined);
    // Allow the cleanup .then callback to fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(q.has("k")).toBe(false);
  });
});
