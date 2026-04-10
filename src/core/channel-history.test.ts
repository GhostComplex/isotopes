// src/core/channel-history.test.ts — Tests for channel history buffer

import { describe, it, expect } from "vitest";
import { ChannelHistoryBuffer, buildHistoryContext, type HistoryEntry } from "./channel-history.js";

// ---------------------------------------------------------------------------
// ChannelHistoryBuffer
// ---------------------------------------------------------------------------

describe("ChannelHistoryBuffer", () => {
  it("appends and consumes entries", () => {
    const buf = new ChannelHistoryBuffer();
    buf.append("ch1", { sender: "Alice", body: "hello" });
    buf.append("ch1", { sender: "Bob", body: "world" });

    const entries = buf.consumeAndClear("ch1");
    expect(entries).toHaveLength(2);
    expect(entries[0].sender).toBe("Alice");
    expect(entries[1].sender).toBe("Bob");
  });

  it("clears after consume", () => {
    const buf = new ChannelHistoryBuffer();
    buf.append("ch1", { sender: "Alice", body: "hello" });
    buf.consumeAndClear("ch1");

    expect(buf.consumeAndClear("ch1")).toEqual([]);
    expect(buf.peek("ch1")).toEqual([]);
  });

  it("returns empty array for unknown channel", () => {
    const buf = new ChannelHistoryBuffer();
    expect(buf.consumeAndClear("unknown")).toEqual([]);
  });

  it("enforces per-channel FIFO limit", () => {
    const buf = new ChannelHistoryBuffer({ maxEntriesPerChannel: 2 });
    buf.append("ch1", { sender: "A", body: "1" });
    buf.append("ch1", { sender: "B", body: "2" });
    buf.append("ch1", { sender: "C", body: "3" });

    const entries = buf.consumeAndClear("ch1");
    expect(entries).toHaveLength(2);
    expect(entries[0].sender).toBe("B");
    expect(entries[1].sender).toBe("C");
  });

  it("evicts oldest channels when over maxChannels", () => {
    const buf = new ChannelHistoryBuffer({ maxChannels: 2 });
    buf.append("ch1", { sender: "A", body: "1" });
    buf.append("ch2", { sender: "B", body: "2" });
    buf.append("ch3", { sender: "C", body: "3" });

    expect(buf.size).toBe(2);
    expect(buf.peek("ch1")).toEqual([]); // evicted
    expect(buf.peek("ch2")).toHaveLength(1);
    expect(buf.peek("ch3")).toHaveLength(1);
  });

  it("refreshes LRU position on append", () => {
    const buf = new ChannelHistoryBuffer({ maxChannels: 2 });
    buf.append("ch1", { sender: "A", body: "1" });
    buf.append("ch2", { sender: "B", body: "2" });
    // Touch ch1 again — now ch2 is oldest
    buf.append("ch1", { sender: "A", body: "1b" });
    // Add ch3 — ch2 should be evicted
    buf.append("ch3", { sender: "C", body: "3" });

    expect(buf.peek("ch2")).toEqual([]); // evicted
    expect(buf.peek("ch1")).toHaveLength(2); // refreshed
    expect(buf.peek("ch3")).toHaveLength(1);
  });

  it("peek does not clear entries", () => {
    const buf = new ChannelHistoryBuffer();
    buf.append("ch1", { sender: "A", body: "1" });

    expect(buf.peek("ch1")).toHaveLength(1);
    expect(buf.peek("ch1")).toHaveLength(1); // still there
  });

  it("explicit clear removes entries", () => {
    const buf = new ChannelHistoryBuffer();
    buf.append("ch1", { sender: "A", body: "1" });
    buf.clear("ch1");
    expect(buf.peek("ch1")).toEqual([]);
  });

  it("tracks channel count via size", () => {
    const buf = new ChannelHistoryBuffer();
    expect(buf.size).toBe(0);
    buf.append("ch1", { sender: "A", body: "1" });
    expect(buf.size).toBe(1);
    buf.append("ch2", { sender: "B", body: "2" });
    expect(buf.size).toBe(2);
    buf.consumeAndClear("ch1");
    expect(buf.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildHistoryContext
// ---------------------------------------------------------------------------

describe("buildHistoryContext", () => {
  it("returns currentMessage unchanged when no entries", () => {
    expect(buildHistoryContext([], "hello bot")).toBe("hello bot");
  });

  it("wraps entries with markers", () => {
    const entries: HistoryEntry[] = [
      { sender: "Alice", body: "I think we should use Redis" },
      { sender: "Bob", body: "How about in-memory cache instead" },
    ];
    const result = buildHistoryContext(entries, "@bot what do you think?");

    expect(result).toContain("[Chat messages since your last reply - for context]");
    expect(result).toContain("Alice: I think we should use Redis");
    expect(result).toContain("Bob: How about in-memory cache instead");
    expect(result).toContain("[Current message - respond to this]");
    expect(result).toContain("@bot what do you think?");
  });

  it("preserves entry order", () => {
    const entries: HistoryEntry[] = [
      { sender: "A", body: "first" },
      { sender: "B", body: "second" },
      { sender: "C", body: "third" },
    ];
    const result = buildHistoryContext(entries, "msg");
    const aIdx = result.indexOf("A: first");
    const bIdx = result.indexOf("B: second");
    const cIdx = result.indexOf("C: third");
    expect(aIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(cIdx);
  });
});
