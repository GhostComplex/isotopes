// src/vnext/gateway/mention.test.ts — Unit tests for mention detection

import { describe, it, expect } from "vitest";
import { shouldRespondToMessage } from "./mention.js";
import type { MentionContext } from "./mention.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ctx(overrides: Partial<MentionContext> = {}): MentionContext {
  return {
    isMentioned: false,
    isDM: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// shouldRespondToMessage
// ---------------------------------------------------------------------------

describe("shouldRespondToMessage", () => {
  it("always responds to DMs regardless of mention", () => {
    expect(shouldRespondToMessage(ctx({ isDM: true, isMentioned: false }))).toBe(true);
  });

  it("always responds to DMs even with requireMention=true", () => {
    expect(shouldRespondToMessage(ctx({ isDM: true, requireMention: true }))).toBe(true);
  });

  it("does not respond when not mentioned and requireMention defaults to true", () => {
    expect(shouldRespondToMessage(ctx({ isMentioned: false }))).toBe(false);
  });

  it("responds when mentioned and requireMention defaults to true", () => {
    expect(shouldRespondToMessage(ctx({ isMentioned: true }))).toBe(true);
  });

  it("does not respond when not mentioned and requireMention=true", () => {
    expect(shouldRespondToMessage(ctx({ requireMention: true, isMentioned: false }))).toBe(false);
  });

  it("responds when mentioned and requireMention=true", () => {
    expect(shouldRespondToMessage(ctx({ requireMention: true, isMentioned: true }))).toBe(true);
  });

  it("responds without mention when requireMention=false", () => {
    expect(shouldRespondToMessage(ctx({ requireMention: false, isMentioned: false }))).toBe(true);
  });

  it("responds with mention when requireMention=false", () => {
    expect(shouldRespondToMessage(ctx({ requireMention: false, isMentioned: true }))).toBe(true);
  });
});
