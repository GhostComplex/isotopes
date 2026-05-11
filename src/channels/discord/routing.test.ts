// src/channels/discord/routing.test.ts — Tests for agent/session routing helpers.

import { describe, it, expect } from "vitest";
import type { Message as DiscordMessage } from "discord.js";
import { resolveAgentId, resolveSessionKey } from "./routing.js";

const BOT_ID = "111111";

interface FakeMsgOpts {
  id?: string;
  channelId?: string;
  authorId?: string;
  authorBot?: boolean;
  authorUsername?: string;
  guildId?: string | null;
  threadId?: string | null;
  content?: string;
  mentionedIds?: string[];
  referencedAuthorId?: string;
  timestamp?: number;
}

function fakeMsg(opts: FakeMsgOpts = {}): DiscordMessage {
  const mentionedIds = new Set(opts.mentionedIds ?? []);
  const referencedMessage = opts.referencedAuthorId
    ? { author: { id: opts.referencedAuthorId } }
    : undefined;
  const guild = opts.guildId === null ? null : { id: opts.guildId ?? "guild-1" };
  return {
    id: opts.id ?? "msg-1",
    channelId: opts.channelId ?? "channel-1",
    content: opts.content ?? "hello",
    createdTimestamp: opts.timestamp ?? 1700000000000,
    author: {
      id: opts.authorId ?? "user-1",
      username: opts.authorUsername ?? "alice",
      bot: opts.authorBot ?? false,
    },
    guild,
    thread: opts.threadId ? { id: opts.threadId } : null,
    mentions: { has: (id: string) => mentionedIds.has(id) },
    referencedMessage,
  } as unknown as DiscordMessage;
}

describe("resolveAgentId", () => {
  it("uses agentBindings when a mention matches", () => {
    const msg = fakeMsg({ mentionedIds: ["bot-A"] });
    expect(resolveAgentId(msg, { "bot-A": "alpha", "bot-B": "beta" }, "default")).toBe("alpha");
  });
  it("falls back to default when no binding matches", () => {
    const msg = fakeMsg({ mentionedIds: [] });
    expect(resolveAgentId(msg, { "bot-A": "alpha" }, "fallback")).toBe("fallback");
  });
});

describe("resolveSessionKey", () => {
  it("derives a thread session key", () => {
    const msg = fakeMsg({ threadId: "thr-9" });
    expect(resolveSessionKey(msg, BOT_ID)).toBe(`discord:${BOT_ID}:thread:thr-9`);
  });
  it("derives a DM session key (per-user)", () => {
    const msg = fakeMsg({ guildId: null, authorId: "user-7" });
    expect(resolveSessionKey(msg, BOT_ID)).toBe(`discord:${BOT_ID}:dm:user-7`);
  });
  it("derives a channel session key (guild, no thread)", () => {
    const msg = fakeMsg({ channelId: "chan-3" });
    expect(resolveSessionKey(msg, BOT_ID)).toBe(`discord:${BOT_ID}:channel:chan-3`);
  });
});
