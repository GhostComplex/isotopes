import { describe, it, expect } from "vitest";
import { PendingBuffer } from "./pending-buffer.js";
import type { Message } from "./types.js";

function msg(content: string): Message {
  return { agentId: "main", content, source: "tui" };
}

describe("PendingBuffer", () => {
  it("returns 0 for empty session", () => {
    const buf = new PendingBuffer();
    expect(buf.count("s1")).toBe(0);
  });

  it("add returns new queue depth", () => {
    const buf = new PendingBuffer();
    expect(buf.add("s1", msg("a"))).toBe(1);
    expect(buf.add("s1", msg("b"))).toBe(2);
    expect(buf.count("s1")).toBe(2);
  });

  it("drain returns all and clears", () => {
    const buf = new PendingBuffer();
    buf.add("s1", msg("a"));
    buf.add("s1", msg("b"));
    const out = buf.drain("s1");
    expect(out).toHaveLength(2);
    expect(out[0].content).toBe("a");
    expect(buf.count("s1")).toBe(0);
  });

  it("drain on empty returns []", () => {
    const buf = new PendingBuffer();
    expect(buf.drain("s1")).toEqual([]);
  });

  it("isolates sessions", () => {
    const buf = new PendingBuffer();
    buf.add("s1", msg("a"));
    buf.add("s2", msg("b"));
    expect(buf.count("s1")).toBe(1);
    expect(buf.count("s2")).toBe(1);
    buf.drain("s1");
    expect(buf.count("s2")).toBe(1);
  });
});
