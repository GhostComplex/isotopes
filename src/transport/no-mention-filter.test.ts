// src/transport/no-mention-filter.test.ts

import { describe, it, expect } from "vitest";
import { shouldDeliver } from "./no-mention-filter.js";

describe("shouldDeliver", () => {
  const baseMsg = { authorId: "user-1", mentions: [] as string[] };

  it("requires explicit @-mention when no-mention is disabled", () => {
    expect(shouldDeliver("main", baseMsg, { enabled: false })).toBe(false);
    expect(shouldDeliver("main", { ...baseMsg, mentions: ["main"] }, { enabled: false })).toBe(true);
  });

  it("delivers all messages when no-mention is enabled", () => {
    expect(shouldDeliver("main", baseMsg, { enabled: true })).toBe(true);
  });

  it("ignores self when configured", () => {
    expect(shouldDeliver("main", { authorId: "main", mentions: [] }, { enabled: true, ignoreSelf: true }))
      .toBe(false);
    expect(shouldDeliver("main", { authorId: "main", mentions: ["main"] }, { enabled: false, ignoreSelf: true }))
      .toBe(false);
  });

  it("ignores other bots when configured", () => {
    expect(shouldDeliver("main", { authorId: "x", isBot: true, mentions: [] }, { enabled: true, ignoreBots: true }))
      .toBe(false);
    expect(shouldDeliver("main", { authorId: "x", isBot: true, mentions: [] }, { enabled: true }))
      .toBe(true);
  });
});
