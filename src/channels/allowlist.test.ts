import { describe, it, expect } from "vitest";
import { matchesAllowedChannel } from "./allowlist.js";

describe("matchesAllowedChannel", () => {
  it("matches a type:channelId entry exactly", () => {
    expect(matchesAllowedChannel({ type: "discord", channelId: "123" }, ["discord:123"])).toBe(true);
    expect(matchesAllowedChannel({ type: "discord", channelId: "999" }, ["discord:123"])).toBe(false);
  });

  it("matches a bare channelId entry against any type", () => {
    expect(matchesAllowedChannel({ type: "discord", channelId: "123" }, ["123"])).toBe(true);
    expect(matchesAllowedChannel({ type: "telegram", channelId: "123" }, ["123"])).toBe(true);
  });

  it("rejects type mismatch on a type:channelId entry", () => {
    expect(matchesAllowedChannel({ type: "telegram", channelId: "123" }, ["discord:123"])).toBe(false);
  });

  it("ignores empty / whitespace entries", () => {
    expect(matchesAllowedChannel({ type: "discord", channelId: "123" }, ["", "  ", "discord:123"])).toBe(true);
  });
});
