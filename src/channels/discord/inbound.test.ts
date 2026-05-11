// src/channels/discord/receive.test.ts — Inbound pipeline tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message as DiscordMessage } from "discord.js";
import { DedupeCache } from "./dedupe.js";
import {
  handleInbound,
  passesAllowlist,
} from "./inbound.js";
import type { Gateway, DispatchCallbacks } from "../../gateway/index.js";
import type { DiscordAccountConfig } from "./types.js";

const BOT_ID = "111111";

interface FakeMsgOpts {
  id?: string;
  channelId?: string;
  authorId?: string;
  authorBot?: boolean;
  authorUsername?: string;
  guildId?: string | null;
  threadId?: string | null;
  parentChannelId?: string;
  content?: string;
  mentionedIds?: string[];
  timestamp?: number;
}

function fakeMsg(opts: FakeMsgOpts = {}): DiscordMessage {
  const mentionedIds = new Set(opts.mentionedIds ?? []);
  const guild = opts.guildId === null ? null : { id: opts.guildId ?? "guild-1" };
  // In real Discord, a thread message has channelId = thread id and
  // channel.isThread() === true. parentId is the parent channel.
  const isThread = Boolean(opts.threadId);
  const channelId = isThread ? opts.threadId! : opts.channelId ?? "channel-1";
  const channel = isThread
    ? { isThread: () => true, parentId: opts.parentChannelId ?? "channel-parent-1" }
    : { isThread: () => false };
  return {
    id: opts.id ?? "msg-1",
    channelId,
    content: opts.content ?? "hello",
    createdTimestamp: opts.timestamp ?? 1700000000000,
    author: {
      id: opts.authorId ?? "user-1",
      username: opts.authorUsername ?? "alice",
      bot: opts.authorBot ?? false,
    },
    guild,
    channel,
    mentions: { has: (id: string) => mentionedIds.has(id) },
  } as unknown as DiscordMessage;
}

function makeGateway(): Gateway & { dispatch: ReturnType<typeof vi.fn> } {
  return {
    dispatch: vi.fn().mockResolvedValue({
      sessionId: "s",
      state: "started",
      responseText: "",
      errorMessage: null,
    }),
    abort: vi.fn().mockResolvedValue(undefined),
    abortByKey: vi.fn().mockResolvedValue(false),
  } as Gateway & { dispatch: ReturnType<typeof vi.fn> };
}

describe("handleInbound", () => {
  let gateway: ReturnType<typeof makeGateway>;
  let dedupe: DedupeCache;
  let buildCallbacks: ReturnType<typeof vi.fn>;
  let cbObj: DispatchCallbacks;

  beforeEach(() => {
    gateway = makeGateway();
    dedupe = new DedupeCache();
    cbObj = {};
    buildCallbacks = vi.fn().mockReturnValue(cbObj);
  });

  const ctx = () => ({ botId: BOT_ID, buildCallbacks });
  // Construct routing the way dispatchInbound (in index.ts) would, but inline
  // — handleInbound's contract is "you give me agentId + sessionKey", not "you
  // share my computation".
  const sessionKeyFor = (msg: DiscordMessage, botId = BOT_ID): string => {
    const ch = msg.channel as { isThread?: () => boolean };
    if (ch?.isThread?.()) return `discord:${botId}:thread:${msg.channelId}`;
    if (!msg.guild) return `discord:${botId}:dm:${msg.author.id}`;
    return `discord:${botId}:channel:${msg.channelId}`;
  };
  const route = (msg: DiscordMessage, agentId = "main") => ({
    agentId,
    sessionKey: sessionKeyFor(msg),
  });

  it("drops duplicate messages on second receive", async () => {
    const msg = fakeMsg({ mentionedIds: [BOT_ID] });
    await handleInbound(msg, route(msg), { gateway, dedupe }, ctx());
    await handleInbound(msg, route(msg), { gateway, dedupe }, ctx());
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
  });

  it("drops self-authored messages", async () => {
    const msg = fakeMsg({ authorId: BOT_ID });
    await handleInbound(msg, route(msg), { gateway, dedupe }, ctx());
    expect(gateway.dispatch).not.toHaveBeenCalled();
  });

  it("drops other bots by default", async () => {
    const msg = fakeMsg({ authorBot: true, mentionedIds: [BOT_ID] });
    await handleInbound(msg, route(msg), { gateway, dedupe }, ctx());
    expect(gateway.dispatch).not.toHaveBeenCalled();
  });

  it("respects allowBots=true", async () => {
    const msg = fakeMsg({ authorBot: true, mentionedIds: [BOT_ID] });
    await handleInbound(msg, route(msg), { gateway, dedupe, allowBots: true }, ctx());
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
  });

  it("dispatches on precise @mention", async () => {
    const msg = fakeMsg({ mentionedIds: [BOT_ID], content: `<@${BOT_ID}> hi there` });
    await handleInbound(msg, route(msg), { gateway, dedupe }, ctx());
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    const [message, callbacks] = gateway.dispatch.mock.calls[0];
    expect(message).toMatchObject({
      agentId: "main",
      sessionKey: `discord:${BOT_ID}:channel:channel-1`,
      content: "hi there",
      source: "channel",
      sender: "alice",
    });
    expect(message.extraSystemPrompt).toContain("Chat Reply Tags");
    expect(callbacks).toBe(cbObj);
    expect(buildCallbacks).toHaveBeenCalledWith(msg);
  });

  it("dispatches on DM regardless of mention", async () => {
    const msg = fakeMsg({ guildId: null });
    await handleInbound(msg, route(msg), { gateway, dedupe }, ctx());
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(gateway.dispatch.mock.calls[0][0].sessionKey).toBe(`discord:${BOT_ID}:dm:user-1`);
  });

  it("drops guild messages with no mention when requireMention=true (default)", async () => {
    const msg = fakeMsg();
    await handleInbound(msg, route(msg), { gateway, dedupe }, ctx());
    expect(gateway.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches guild messages with no mention when requireMention=false", async () => {
    const msg = fakeMsg({ guildId: "g-1" });
    await handleInbound(
      msg,
      route(msg),
      { gateway, dedupe, guilds: { "g-1": { requireMention: false } } },
      ctx(),
    );
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
  });

  it("forwards routing.agentId to dispatch", async () => {
    const msg = fakeMsg({ mentionedIds: ["222222"], guildId: "g-1" });
    await handleInbound(
      msg,
      { agentId: "alpha", sessionKey: sessionKeyFor(msg) },
      { gateway, dedupe, guilds: { "g-1": { requireMention: false } } },
      ctx(),
    );
    expect(gateway.dispatch.mock.calls[0][0].agentId).toBe("alpha");
  });

  it("uses thread session key when message is in a thread", async () => {
    const msg = fakeMsg({ threadId: "thr-42", mentionedIds: [BOT_ID] });
    await handleInbound(msg, route(msg), { gateway, dedupe }, ctx());
    expect(gateway.dispatch.mock.calls[0][0].sessionKey).toBe(`discord:${BOT_ID}:thread:thr-42`);
  });

  it("drops thread messages when respondInThreads=false for the guild", async () => {
    const msg = fakeMsg({ threadId: "thr-x", guildId: "g-1", mentionedIds: [BOT_ID] });
    await handleInbound(
      msg,
      route(msg),
      { gateway, dedupe, guilds: { "g-1": { respondInThreads: false } } },
      ctx(),
    );
    expect(gateway.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches thread messages when respondInThreads=true (default)", async () => {
    const msg = fakeMsg({ threadId: "thr-y", guildId: "g-1", mentionedIds: [BOT_ID] });
    await handleInbound(msg, route(msg), { gateway, dedupe }, ctx());
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
  });

  it("applies transformContent hook to dispatched content", async () => {
    const msg = fakeMsg({ mentionedIds: [BOT_ID], content: `<@${BOT_ID}> hi there` });
    const transform = vi.fn((content: string) => `<meta/>\n${content}`);
    await handleInbound(
      msg,
      route(msg),
      { gateway, dedupe, transformContent: transform },
      ctx(),
    );
    expect(transform).toHaveBeenCalledWith("hi there", msg);
    expect(gateway.dispatch.mock.calls[0][0].content).toBe("<meta/>\nhi there");
  });

  it("calls flushRemaining on the callbacks after dispatch resolves", async () => {
    const gateway = makeGateway();
    const dedupe = new DedupeCache();
    const msg = fakeMsg({ content: "<@bot> hi", mentionedIds: ["bot"] });
    const flushRemaining = vi.fn().mockResolvedValue(undefined);
    const onTextDelta = vi.fn();
    const callbacks = { onTextDelta, flushRemaining };
    await handleInbound(
      msg,
      { agentId: "main", sessionKey: sessionKeyFor(msg, "bot") },
      { gateway, dedupe },
      { botId: "bot", buildCallbacks: () => callbacks },
    );
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(flushRemaining).toHaveBeenCalledTimes(1);
  });

  it("does not throw when callbacks omit flushRemaining (plain DispatchCallbacks)", async () => {
    const gateway = makeGateway();
    const dedupe = new DedupeCache();
    const msg = fakeMsg({ content: "<@bot> hi", mentionedIds: ["bot"] });
    const callbacks = { onTextDelta: vi.fn() };
    await expect(
      handleInbound(
        msg,
        { agentId: "main", sessionKey: sessionKeyFor(msg, "bot") },
        { gateway, dedupe },
        { botId: "bot", buildCallbacks: () => callbacks },
      ),
    ).resolves.toBeUndefined();
  });

  it("calls flushRemaining even when gateway.dispatch throws (no resource leak)", async () => {
    const gateway = makeGateway();
    gateway.dispatch.mockRejectedValueOnce(new Error("boom"));
    const dedupe = new DedupeCache();
    const msg = fakeMsg({ content: "<@bot> hi", mentionedIds: ["bot"] });
    const flushRemaining = vi.fn().mockResolvedValue(undefined);
    const callbacks = { onTextDelta: vi.fn(), flushRemaining };
    await expect(
      handleInbound(
        msg,
        { agentId: "main", sessionKey: sessionKeyFor(msg, "bot") },
        { gateway, dedupe },
        { botId: "bot", buildCallbacks: () => callbacks },
      ),
    ).rejects.toThrow("boom");
    expect(flushRemaining).toHaveBeenCalledTimes(1);
  });
});

describe("passesAllowlist (allowlist policy)", () => {
  const account = (groupAccess: DiscordAccountConfig["groupAccess"]): DiscordAccountConfig => ({
    token: "t",
    defaultAgentId: "main",
    groupAccess,
  });

  it("denies when allowlist policy has no rules (fail-closed)", () => {
    const acc = account({ policy: "allowlist" });
    expect(passesAllowlist(fakeMsg({ guildId: "g-1" }), acc)).toBe(false);
  });

  it("denies when both allowlists are empty arrays", () => {
    const acc = account({ policy: "allowlist", guildAllowlist: [], channelAllowlist: [] });
    expect(passesAllowlist(fakeMsg({ guildId: "g-1" }), acc)).toBe(false);
  });

  it("guild-only: passes when guild matches", () => {
    const acc = account({ policy: "allowlist", guildAllowlist: ["g-1"] });
    expect(passesAllowlist(fakeMsg({ guildId: "g-1" }), acc)).toBe(true);
  });

  it("guild-only: drops other guilds", () => {
    const acc = account({ policy: "allowlist", guildAllowlist: ["g-1"] });
    expect(passesAllowlist(fakeMsg({ guildId: "g-2" }), acc)).toBe(false);
  });

  it("channel-only: passes when channel matches", () => {
    const acc = account({ policy: "allowlist", channelAllowlist: ["channel-1"] });
    expect(passesAllowlist(fakeMsg({ guildId: "g-1", channelId: "channel-1" }), acc)).toBe(true);
  });

  it("channel-only: drops other channels", () => {
    const acc = account({ policy: "allowlist", channelAllowlist: ["channel-1"] });
    expect(passesAllowlist(fakeMsg({ guildId: "g-1", channelId: "channel-2" }), acc)).toBe(false);
  });

  it("both set: passes only when guild AND channel match", () => {
    const acc = account({
      policy: "allowlist",
      guildAllowlist: ["g-1"],
      channelAllowlist: ["channel-1"],
    });
    expect(passesAllowlist(fakeMsg({ guildId: "g-1", channelId: "channel-1" }), acc)).toBe(true);
  });

  it("both set: drops when guild matches but channel does not", () => {
    const acc = account({
      policy: "allowlist",
      guildAllowlist: ["g-1"],
      channelAllowlist: ["channel-1"],
    });
    expect(passesAllowlist(fakeMsg({ guildId: "g-1", channelId: "channel-2" }), acc)).toBe(false);
  });

  it("both set: drops when channel matches but guild does not", () => {
    const acc = account({
      policy: "allowlist",
      guildAllowlist: ["g-1"],
      channelAllowlist: ["channel-1"],
    });
    expect(passesAllowlist(fakeMsg({ guildId: "g-2", channelId: "channel-1" }), acc)).toBe(false);
  });

  it("empty guild list with channel set: drops everything", () => {
    const acc = account({
      policy: "allowlist",
      guildAllowlist: [],
      channelAllowlist: ["channel-1"],
    });
    expect(passesAllowlist(fakeMsg({ guildId: "g-1", channelId: "channel-1" }), acc)).toBe(false);
  });

  it("thread message passes when its parent channel is in channelAllowlist", () => {
    const acc = account({ policy: "allowlist", channelAllowlist: ["channel-parent-1"] });
    const msg = fakeMsg({ guildId: "g-1", threadId: "thr-1", parentChannelId: "channel-parent-1" });
    expect(passesAllowlist(msg, acc)).toBe(true);
  });

  it("thread message dropped when parent not in channelAllowlist", () => {
    const acc = account({ policy: "allowlist", channelAllowlist: ["channel-other"] });
    const msg = fakeMsg({ guildId: "g-1", threadId: "thr-1", parentChannelId: "channel-parent-1" });
    expect(passesAllowlist(msg, acc)).toBe(false);
  });

  it("policy=disabled drops all guild messages", () => {
    const acc = account({ policy: "disabled" });
    expect(passesAllowlist(fakeMsg({ guildId: "g-1" }), acc)).toBe(false);
  });
});
