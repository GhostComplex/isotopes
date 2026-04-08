// src/core/mention.test.ts — Unit tests for mention detection

import { describe, it, expect } from "vitest";
import { shouldRespondToMessage, resolveRequireMention } from "./mention.js";
import type { ChannelsConfig } from "./types.js";
import type { MentionContext } from "./mention.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ctx(overrides: Partial<MentionContext> = {}): MentionContext {
  return {
    botUserId: "bot-123",
    guildId: "guild-1",
    accountId: "major",
    isMentioned: false,
    isDM: false,
    ...overrides,
  };
}

function channelsWithGuild(
  accountId: string,
  guildId: string,
  requireMention: boolean,
): ChannelsConfig {
  return {
    discord: {
      accounts: {
        [accountId]: {
          guilds: {
            [guildId]: { requireMention },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// resolveRequireMention
// ---------------------------------------------------------------------------

describe("resolveRequireMention", () => {
  it("returns true (default) when channels config is undefined", () => {
    expect(resolveRequireMention(undefined, "major", "guild-1")).toBe(true);
  });

  it("returns true when no discord section exists", () => {
    const channels: ChannelsConfig = {};
    expect(resolveRequireMention(channels, "major", "guild-1")).toBe(true);
  });

  it("returns true when accountId is undefined", () => {
    const channels = channelsWithGuild("major", "guild-1", false);
    expect(resolveRequireMention(channels, undefined, "guild-1")).toBe(true);
  });

  it("returns true when account has no guilds config", () => {
    const channels: ChannelsConfig = {
      discord: {
        accounts: {
          major: {},
        },
      },
    };
    expect(resolveRequireMention(channels, "major", "guild-1")).toBe(true);
  });

  it("returns true when guild is not listed in config", () => {
    const channels = channelsWithGuild("major", "guild-1", false);
    expect(resolveRequireMention(channels, "major", "guild-other")).toBe(true);
  });

  it("returns true when guild config has requireMention: true", () => {
    const channels = channelsWithGuild("major", "guild-1", true);
    expect(resolveRequireMention(channels, "major", "guild-1")).toBe(true);
  });

  it("returns false when guild config has requireMention: false", () => {
    const channels = channelsWithGuild("major", "guild-1", false);
    expect(resolveRequireMention(channels, "major", "guild-1")).toBe(false);
  });

  it("defaults to true when requireMention is not specified in guild config", () => {
    const channels: ChannelsConfig = {
      discord: {
        accounts: {
          major: {
            guilds: {
              "guild-1": {},
            },
          },
        },
      },
    };
    expect(resolveRequireMention(channels, "major", "guild-1")).toBe(true);
  });

  it("handles different accounts independently", () => {
    const channels: ChannelsConfig = {
      discord: {
        accounts: {
          major: {
            guilds: {
              "guild-1": { requireMention: false },
            },
          },
          tachikoma: {
            guilds: {
              "guild-1": { requireMention: true },
            },
          },
        },
      },
    };
    expect(resolveRequireMention(channels, "major", "guild-1")).toBe(false);
    expect(resolveRequireMention(channels, "tachikoma", "guild-1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldRespondToMessage
// ---------------------------------------------------------------------------

describe("shouldRespondToMessage", () => {
  // -----------------------------------------------------------------------
  // DM handling
  // -----------------------------------------------------------------------

  it("always responds to DMs regardless of mention", () => {
    expect(
      shouldRespondToMessage(undefined, ctx({ isDM: true, isMentioned: false })),
    ).toBe(true);
  });

  it("always responds to DMs even with channels config", () => {
    const channels = channelsWithGuild("major", "guild-1", true);
    expect(
      shouldRespondToMessage(channels, ctx({ isDM: true, isMentioned: false })),
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Default behavior (requireMention = true)
  // -----------------------------------------------------------------------

  it("does not respond when not mentioned and no channels config", () => {
    expect(
      shouldRespondToMessage(undefined, ctx({ isMentioned: false })),
    ).toBe(false);
  });

  it("responds when mentioned and no channels config", () => {
    expect(
      shouldRespondToMessage(undefined, ctx({ isMentioned: true })),
    ).toBe(true);
  });

  it("does not respond when not mentioned and requireMention=true", () => {
    const channels = channelsWithGuild("major", "guild-1", true);
    expect(
      shouldRespondToMessage(channels, ctx({ isMentioned: false })),
    ).toBe(false);
  });

  it("responds when mentioned and requireMention=true", () => {
    const channels = channelsWithGuild("major", "guild-1", true);
    expect(
      shouldRespondToMessage(channels, ctx({ isMentioned: true })),
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // requireMention = false
  // -----------------------------------------------------------------------

  it("responds without mention when requireMention=false", () => {
    const channels = channelsWithGuild("major", "guild-1", false);
    expect(
      shouldRespondToMessage(channels, ctx({ isMentioned: false })),
    ).toBe(true);
  });

  it("responds with mention when requireMention=false", () => {
    const channels = channelsWithGuild("major", "guild-1", false);
    expect(
      shouldRespondToMessage(channels, ctx({ isMentioned: true })),
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Guild not configured
  // -----------------------------------------------------------------------

  it("falls back to mention-required when guild is not in config", () => {
    const channels = channelsWithGuild("major", "guild-1", false);
    expect(
      shouldRespondToMessage(
        channels,
        ctx({ guildId: "guild-other", isMentioned: false }),
      ),
    ).toBe(false);
  });

  it("responds to mention in unconfigured guild", () => {
    const channels = channelsWithGuild("major", "guild-1", false);
    expect(
      shouldRespondToMessage(
        channels,
        ctx({ guildId: "guild-other", isMentioned: true }),
      ),
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // No guild context (e.g. missing guildId)
  // -----------------------------------------------------------------------

  it("falls back to mention check when no guildId", () => {
    expect(
      shouldRespondToMessage(
        undefined,
        ctx({ guildId: undefined, isDM: false, isMentioned: false }),
      ),
    ).toBe(false);
  });

  it("responds to mention when no guildId", () => {
    expect(
      shouldRespondToMessage(
        undefined,
        ctx({ guildId: undefined, isDM: false, isMentioned: true }),
      ),
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Multi-account scenarios
  // -----------------------------------------------------------------------

  it("respects per-account guild config", () => {
    const channels: ChannelsConfig = {
      discord: {
        accounts: {
          major: {
            guilds: {
              "guild-1": { requireMention: false },
            },
          },
          tachikoma: {
            guilds: {
              "guild-1": { requireMention: true },
            },
          },
        },
      },
    };

    // major in guild-1: no mention required
    expect(
      shouldRespondToMessage(
        channels,
        ctx({ accountId: "major", guildId: "guild-1", isMentioned: false }),
      ),
    ).toBe(true);

    // tachikoma in guild-1: mention required
    expect(
      shouldRespondToMessage(
        channels,
        ctx({ accountId: "tachikoma", guildId: "guild-1", isMentioned: false }),
      ),
    ).toBe(false);
  });
});
