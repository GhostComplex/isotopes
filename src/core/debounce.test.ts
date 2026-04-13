// src/core/debounce.test.ts — Tests for inbound message debouncer

import { describe, it, expect, vi, afterEach } from "vitest";
import { InboundDebouncer } from "./debounce.js";

describe("InboundDebouncer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves single message after window expires", async () => {
    vi.useFakeTimers();
    const debouncer = new InboundDebouncer({ windowMs: 100 });

    const promise = debouncer.submit("key1", "hello", "msg1", 1000, { userId: "u1" });
    vi.advanceTimersByTime(100);

    const result = await promise;
    expect(result).not.toBeNull();
    expect(result!.text).toBe("hello");
    expect(result!.messageIds).toEqual(["msg1"]);
    expect(result!.metadata).toEqual({ userId: "u1" });
  });

  it("combines multiple messages with newline", async () => {
    vi.useFakeTimers();
    const debouncer = new InboundDebouncer({ windowMs: 100 });

    const p1 = debouncer.submit("key1", "hello", "msg1", 1000);
    const p2 = debouncer.submit("key1", "world", "msg2", 1050);
    vi.advanceTimersByTime(100);

    const result = await p1;
    expect(result).not.toBeNull();
    expect(result!.text).toBe("hello\nworld");
    expect(result!.messageIds).toEqual(["msg1", "msg2"]);

    // Secondary caller gets null
    const secondary = await p2;
    expect(secondary).toBeNull();
  });

  it("resets timer on each new message", async () => {
    vi.useFakeTimers();
    const debouncer = new InboundDebouncer({ windowMs: 100 });

    const p1 = debouncer.submit("key1", "a", "m1", 1000);
    vi.advanceTimersByTime(80); // 80ms — not yet flushed
    debouncer.submit("key1", "b", "m2", 1080); // resets timer
    vi.advanceTimersByTime(80); // 80ms from reset — still not flushed (need 100)
    expect(debouncer.pendingCount).toBe(1);
    vi.advanceTimersByTime(20); // now 100ms from reset

    const result = await p1;
    expect(result!.text).toBe("a\nb");
  });

  it("handles independent keys separately", async () => {
    vi.useFakeTimers();
    const debouncer = new InboundDebouncer({ windowMs: 100 });

    const p1 = debouncer.submit("key1", "hello", "m1", 1000);
    const p2 = debouncer.submit("key2", "world", "m2", 1000);
    vi.advanceTimersByTime(100);

    const r1 = await p1;
    const r2 = await p2;
    expect(r1!.text).toBe("hello");
    expect(r2!.text).toBe("world");
  });

  it("cancel resolves all waiters with null", async () => {
    vi.useFakeTimers();
    const debouncer = new InboundDebouncer({ windowMs: 100 });

    const p1 = debouncer.submit("key1", "a", "m1", 1000);
    const p2 = debouncer.submit("key1", "b", "m2", 1050);
    debouncer.cancel("key1");

    // Both primary and secondary get null
    const r1 = await p1;
    const r2 = await p2;
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(debouncer.pendingCount).toBe(0);
  });

  it("dispose cancels all pending and resolves with null", async () => {
    vi.useFakeTimers();
    const debouncer = new InboundDebouncer({ windowMs: 100 });

    const p1 = debouncer.submit("key1", "a", "m1", 1000);
    const p2 = debouncer.submit("key2", "b", "m2", 1000);
    expect(debouncer.pendingCount).toBe(2);

    debouncer.dispose();
    expect(debouncer.pendingCount).toBe(0);

    // All primary callers get null
    const r1 = await p1;
    const r2 = await p2;
    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });

  it("tracks timestamps from first and last message", async () => {
    vi.useFakeTimers();
    const debouncer = new InboundDebouncer({ windowMs: 100 });

    const p1 = debouncer.submit("key1", "a", "m1", 1000);
    debouncer.submit("key1", "b", "m2", 1080);
    vi.advanceTimersByTime(100);

    const result = await p1;
    expect(result!.firstTimestamp).toBe(1000);
    expect(result!.lastTimestamp).toBe(1080);
  });
});
