// src/transports/message-metadata.test.ts — Tests for message metadata extraction

import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractDiscordMetadata, extractCliMetadata } from "./message-metadata.js";

// ---------------------------------------------------------------------------
// Mock discord.js message factory
// ---------------------------------------------------------------------------

function createMockDiscordMessage(overrides: Record<string, unknown> = {}) {
  return {
    author: {
      id: "user-123",
      username: "testuser",
      displayName: "Test User",
      bot: false,
      avatarURL: () => "https://cdn.discordapp.com/avatars/user-123/abc.png",
      ...(overrides.author as Record<string, unknown> ?? {}),
    },
    member: {
      displayName: "Server Nickname",
      ...(overrides.member as Record<string, unknown> ?? {}),
    },
    createdTimestamp: 1700000000000,
    channelId: "channel-456",
    channel: {
      type: 0, // GuildText
      name: "general",
      ...(overrides.channel as Record<string, unknown> ?? {}),
    },
    reference: overrides.reference ?? null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractDiscordMetadata", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1700000005000);
  });

  it("extracts sender info from a guild message", () => {
    const msg = createMockDiscordMessage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metadata = extractDiscordMetadata(msg as any);

    expect(metadata.sender).toEqual({
      id: "user-123",
      username: "testuser",
      displayName: "Server Nickname",
      avatar: "https://cdn.discordapp.com/avatars/user-123/abc.png",
      isBot: false,
    });
  });

  it("extracts timestamps", () => {
    const msg = createMockDiscordMessage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metadata = extractDiscordMetadata(msg as any);

    expect(metadata.timestamps.sent).toBe(1700000000000);
    expect(metadata.timestamps.received).toBe(1700000005000);
  });

  it("extracts channel info for a text channel", () => {
    const msg = createMockDiscordMessage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metadata = extractDiscordMetadata(msg as any);

    expect(metadata.channel).toEqual({
      id: "channel-456",
      name: "general",
      type: "text",
    });
  });

  it("resolves DM channel type", () => {
    const msg = createMockDiscordMessage({
      channel: { type: 1, name: null },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metadata = extractDiscordMetadata(msg as any);

    expect(metadata.channel.type).toBe("dm");
    expect(metadata.channel.name).toBeUndefined();
  });

  it("resolves thread channel types", () => {
    for (const threadType of [10, 11, 12]) {
      const msg = createMockDiscordMessage({
        channel: { type: threadType, name: "my-thread" },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const metadata = extractDiscordMetadata(msg as any);
      expect(metadata.channel.type).toBe("thread");
    }
  });

  it("resolves voice and news channel types", () => {
    const voiceMsg = createMockDiscordMessage({ channel: { type: 2, name: "vc" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractDiscordMetadata(voiceMsg as any).channel.type).toBe("voice");

    const newsMsg = createMockDiscordMessage({ channel: { type: 5, name: "announcements" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractDiscordMetadata(newsMsg as any).channel.type).toBe("news");
  });

  it("returns 'unknown' for unrecognized channel types", () => {
    const msg = createMockDiscordMessage({ channel: { type: 99, name: "wat" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metadata = extractDiscordMetadata(msg as any);
    expect(metadata.channel.type).toBe("unknown");
  });

  it("extracts replyTo when message has a reference", () => {
    const msg = createMockDiscordMessage({
      reference: { messageId: "reply-target-789" },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metadata = extractDiscordMetadata(msg as any);
    expect(metadata.replyTo).toBe("reply-target-789");
  });

  it("omits replyTo when no reference", () => {
    const msg = createMockDiscordMessage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metadata = extractDiscordMetadata(msg as any);
    expect(metadata.replyTo).toBeUndefined();
  });

  it("identifies bot senders", () => {
    const msg = createMockDiscordMessage({
      author: {
        id: "bot-999",
        username: "webhookbot",
        displayName: "Webhook Bot",
        bot: true,
        avatarURL: () => null,
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metadata = extractDiscordMetadata(msg as any);

    expect(metadata.sender.isBot).toBe(true);
    expect(metadata.sender.avatar).toBeUndefined();
  });

  it("falls back to author displayName when no member", () => {
    const msg = createMockDiscordMessage({ member: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metadata = extractDiscordMetadata(msg as any);

    expect(metadata.sender.displayName).toBe("Test User");
  });

  it("handles missing displayName on both member and author", () => {
    const msg = createMockDiscordMessage({
      member: null,
      author: {
        id: "user-123",
        username: "testuser",
        displayName: undefined,
        bot: false,
        avatarURL: () => null,
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metadata = extractDiscordMetadata(msg as any);

    expect(metadata.sender.displayName).toBeUndefined();
  });
});

describe("extractCliMetadata", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1700000010000);
  });

  it("returns CLI-specific metadata", () => {
    const metadata = extractCliMetadata();

    expect(metadata.sender).toEqual({
      id: "cli-user",
      username: "cli",
      isBot: false,
    });
    expect(metadata.timestamps.sent).toBe(1700000010000);
    expect(metadata.timestamps.received).toBe(1700000010000);
    expect(metadata.channel).toEqual({
      id: "cli",
      name: "cli",
      type: "dm",
    });
    expect(metadata.replyTo).toBeUndefined();
  });
});
