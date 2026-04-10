// src/core/dedupe.test.ts — Tests for deduplication cache

import { describe, it, expect, vi, afterEach } from "vitest";
import { DedupeCache } from "./dedupe.js";

describe("DedupeCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false for a new key", () => {
    const cache = new DedupeCache();
    expect(cache.isDuplicate("key1")).toBe(false);
  });

  it("returns true for a duplicate key within TTL", () => {
    const cache = new DedupeCache();
    cache.isDuplicate("key1");
    expect(cache.isDuplicate("key1")).toBe(true);
  });

  it("returns false after TTL expires", () => {
    vi.useFakeTimers();
    const cache = new DedupeCache({ ttlMs: 1000 });

    cache.isDuplicate("key1");
    expect(cache.isDuplicate("key1")).toBe(true);

    vi.advanceTimersByTime(1001);
    expect(cache.isDuplicate("key1")).toBe(false);
  });

  it("tracks multiple independent keys", () => {
    const cache = new DedupeCache();
    cache.isDuplicate("key1");
    cache.isDuplicate("key2");

    expect(cache.isDuplicate("key1")).toBe(true);
    expect(cache.isDuplicate("key2")).toBe(true);
    expect(cache.isDuplicate("key3")).toBe(false);
  });

  it("evicts oldest when maxSize is exceeded", () => {
    const cache = new DedupeCache({ maxSize: 2 });
    cache.isDuplicate("key1");
    cache.isDuplicate("key2");
    cache.isDuplicate("key3"); // should evict key1

    expect(cache.size).toBe(2);
    expect(cache.isDuplicate("key1")).toBe(false); // was evicted, treated as new
  });

  it("reports size correctly", () => {
    const cache = new DedupeCache();
    expect(cache.size).toBe(0);
    cache.isDuplicate("a");
    expect(cache.size).toBe(1);
    cache.isDuplicate("b");
    expect(cache.size).toBe(2);
  });

  it("prunes expired entries on insertion", () => {
    vi.useFakeTimers();
    const cache = new DedupeCache({ ttlMs: 1000 });

    cache.isDuplicate("old1");
    cache.isDuplicate("old2");
    vi.advanceTimersByTime(1001);
    cache.isDuplicate("new1"); // triggers prune

    expect(cache.size).toBe(1);
  });
});
