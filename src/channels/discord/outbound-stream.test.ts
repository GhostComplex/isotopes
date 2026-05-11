// Tests for the Discord outbound streaming pipeline.
import { describe, it, expect, vi } from "vitest";
import { SegmentedStreamBuffer } from "./outbound.js";

describe("SegmentedStreamBuffer", () => {
  it("does not flush below maxBufferSize threshold", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new SegmentedStreamBuffer(onFlush, 50);
    await buf.append("Short text. With a boundary.");
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("flushes at sentence boundary once buffer >= threshold", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new SegmentedStreamBuffer(onFlush, 20);
    // Append until length >= 20, with a clean boundary.
    await buf.append("Hello world. This is more text without boundary");
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0]).toBe("Hello world. ");
    expect(buf.getBuffer()).toBe("This is more text without boundary");
  });

  it("flushRemaining drains the buffer", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new SegmentedStreamBuffer(onFlush, 1000);
    await buf.append("leftover");
    expect(onFlush).not.toHaveBeenCalled();
    await buf.flushRemaining();
    expect(onFlush).toHaveBeenCalledWith("leftover");
    expect(buf.getBuffer()).toBe("");
  });

  it("flushRemaining is a no-op when buffer is empty", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new SegmentedStreamBuffer(onFlush, 100);
    await buf.flushRemaining();
    expect(onFlush).not.toHaveBeenCalled();
  });
});
