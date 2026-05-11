// src/channels/discord/receive.test.ts — Inbound pipeline tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message as DiscordMessage } from "discord.js";
import { DedupeCache } from "./dedupe.js";
import {
  detectEngagement,
  handleInbound,
} from "./inbound.js";
import { resolveAgentId, resolveSessionKey } from "./routing.js";
import type { Gateway, DispatchCallbacks } from "../../gateway/index.js";

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

describe("detectEngagement", () => {
  it("returns precise on explicit mention", () => {
    expect(detectEngagement(fakeMsg({ mentionedIds: [BOT_ID] }), BOT_ID)).toBe("mention");
  });
  it("returns dm in a DM", () => {
    expect(detectEngagement(fakeMsg({ guildId: null }), BOT_ID)).toBe("dm");
  });
  it("returns reply when replying to bot's earlier message", () => {
    expect(detectEngagement(fakeMsg({ referencedAuthorId: BOT_ID }), BOT_ID)).toBe("reply");
  });
  it("returns null when not addressed", () => {
    expect(detectEngagement(fakeMsg(), BOT_ID)).toBeNull();
  });
});

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
  const route = (msg: DiscordMessage, agentId = "main") => ({
    agentId,
    sessionKey: resolveSessionKey(msg, BOT_ID),
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

  it("dispatches on reply-chain (user replies to bot)", async () => {
    const msg = fakeMsg({ referencedAuthorId: BOT_ID });
    await handleInbound(msg, route(msg), { gateway, dedupe }, ctx());
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
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

  it("routes via agentBindings when a bound user is mentioned", async () => {
    const msg = fakeMsg({ mentionedIds: ["222222"], guildId: "g-1" });
    const agentId = resolveAgentId(msg, { "222222": "alpha" }, "fallback");
    await handleInbound(
      msg,
      { agentId, sessionKey: resolveSessionKey(msg, BOT_ID) },
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

  it("can disable dedupe via dedupeEnabled=false", async () => {
    const msg = fakeMsg({ mentionedIds: [BOT_ID] });
    const opts = { gateway, dedupe, dedupeEnabled: false };
    await handleInbound(msg, route(msg), opts, ctx());
    await handleInbound(msg, route(msg), opts, ctx());
    expect(gateway.dispatch).toHaveBeenCalledTimes(2);
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
    expect(transform).toHaveBeenCalledWith("hi there", msg, "mention");
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
      { agentId: "main", sessionKey: resolveSessionKey(msg, "bot") },
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
        { agentId: "main", sessionKey: resolveSessionKey(msg, "bot") },
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
        { agentId: "main", sessionKey: resolveSessionKey(msg, "bot") },
        { gateway, dedupe },
        { botId: "bot", buildCallbacks: () => callbacks },
      ),
    ).rejects.toThrow("boom");
    expect(flushRemaining).toHaveBeenCalledTimes(1);
  });
});
