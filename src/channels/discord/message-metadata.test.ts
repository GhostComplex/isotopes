// src/channels/message-metadata.test.ts — Tests for message metadata extraction

import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractDiscordMetadata, formatInboundMeta, type MessageMetadata } from "./message-metadata.js";

// ---------------------------------------------------------------------------
// Mock discord.js message factory
// ---------------------------------------------------------------------------

function createMockDiscordMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? "msg-001",
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
    });
  });

  it("handles DM channel without a name", () => {
    const msg = createMockDiscordMessage({
      channel: { type: 1, name: null },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metadata = extractDiscordMetadata(msg as any);

    expect(metadata.channel.name).toBeUndefined();
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

// ---------------------------------------------------------------------------
// formatInboundMeta tests
// ---------------------------------------------------------------------------

describe("formatInboundMeta", () => {
  it("formats basic metadata for group chat", () => {
    const meta: MessageMetadata = {
      messageId: "msg-001",
      sender: { id: "123", username: "testuser", isBot: false },
      timestamps: { sent: 1700000000000, received: 1700000001000 },
      channel: { id: "456", name: "general" },
    };

    const result = formatInboundMeta(meta, "group");

    expect(result).toBe(
      "[Discord untrusted group ch=general/456 from=testuser/123 ts=2023-11-14T22:13:20.000Z msg=msg-001]",
    );
  });

  it("formats metadata for direct chat (no channel name)", () => {
    const meta: MessageMetadata = {
      messageId: "msg-002",
      sender: { id: "123", username: "testuser", isBot: false },
      timestamps: { sent: 1700000000000, received: 1700000001000 },
      channel: { id: "789" },
    };

    const result = formatInboundMeta(meta, "direct");

    expect(result).toContain("untrusted direct ch=789 ");
    expect(result).not.toMatch(/ch=[^/]*\/789/); // no name slash before id
  });

  it("includes reply= when present", () => {
    const meta: MessageMetadata = {
      messageId: "msg-003",
      sender: { id: "123", username: "testuser", isBot: false },
      timestamps: { sent: 1700000000000, received: 1700000001000 },
      channel: { id: "456" },
      replyTo: "msg-999",
    };

    const result = formatInboundMeta(meta, "group");

    expect(result).toContain("reply=msg-999");
  });

  it("includes display name when distinct from username", () => {
    const meta: MessageMetadata = {
      messageId: "msg-004",
      sender: { id: "123", username: "testuser", displayName: "Test User", isBot: false },
      timestamps: { sent: 1700000000000, received: 1700000001000 },
      channel: { id: "456" },
    };

    const result = formatInboundMeta(meta, "group");

    expect(result).toContain("from=Test User/testuser/123");
  });

  it("collapses sender when displayName equals username", () => {
    const meta: MessageMetadata = {
      messageId: "msg-005",
      sender: { id: "123", username: "alice", displayName: "alice", isBot: false },
      timestamps: { sent: 1700000000000, received: 1700000001000 },
      channel: { id: "456" },
    };

    const result = formatInboundMeta(meta, "group");

    expect(result).toContain("from=alice/123");
    expect(result).not.toContain("alice/alice");
  });

  it("neutralizes brackets and newlines in user-controlled fields", () => {
    const meta: MessageMetadata = {
      messageId: "msg-006",
      sender: { id: "123", username: "evil[bot]", displayName: "Mal\nicious", isBot: false },
      timestamps: { sent: 1700000000000, received: 1700000001000 },
      channel: { id: "456", name: "chan]name[ok" },
    };

    const result = formatInboundMeta(meta, "group");

    expect(result).toContain("ch=chan)name(ok/456");
    expect(result).toContain("from=Mal icious/evil(bot)/123");
    // Header stays a single bracketed line.
    expect(result.startsWith("[")).toBe(true);
    expect(result.endsWith("]")).toBe(true);
    expect(result.split("\n")).toHaveLength(1);
  });
});
