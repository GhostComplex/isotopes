// Tests for the Discord outbound streaming pipeline.
import { describe, it, expect } from "vitest";
import { chunkDiscordMessage } from "./outbound.js";

describe("chunkDiscordMessage", () => {
  it("returns single chunk for short content", () => {
    expect(chunkDiscordMessage("hi")).toEqual(["hi"]);
  });

  it("splits content larger than max length", () => {
    const long = "x".repeat(2500);
    const chunks = chunkDiscordMessage(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(2000);
    }
    expect(chunks.join("")).toBe(long);
  });

  it("prefers newline break points", () => {
    const part = "a".repeat(1500) + "\n" + "b".repeat(1000);
    const chunks = chunkDiscordMessage(part);
    expect(chunks[0]).toBe("a".repeat(1500));
    expect(chunks[1]).toBe("b".repeat(1000));
  });
});
