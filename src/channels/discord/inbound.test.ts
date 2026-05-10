// src/channels/discord/receive.test.ts — Inbound pipeline tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message as DiscordMessage } from "discord.js";
import { DedupeCache } from "./dedupe.js";
import {
  detectMentionKind,
  receiveDiscordMessage,
  resolveAgentId,
  resolveSessionKey,
  stripMentions,
} from "./inbound.js";
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
  snapshots?: Array<{ mentionedIds?: string[]; content?: string }>;
  timestamp?: number;
}

function fakeMsg(opts: FakeMsgOpts = {}): DiscordMessage {
  const mentionedIds = new Set(opts.mentionedIds ?? []);
  const referencedMessage = opts.referencedAuthorId
    ? { author: { id: opts.referencedAuthorId } }
    : undefined;
  const messageSnapshots = opts.snapshots
    ? opts.snapshots.map((s) => ({
        mentions: { has: (id: string) => (s.mentionedIds ?? []).includes(id) },
        content: s.content,
      }))
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
    messageSnapshots,
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

describe("stripMentions", () => {
  it("removes <@id> and <@!id> tokens", () => {
    expect(stripMentions("<@123> hi <@!456>")).toBe("hi");
  });
});

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

describe("detectMentionKind", () => {
  it("returns precise on explicit mention", () => {
    expect(detectMentionKind(fakeMsg({ mentionedIds: [BOT_ID] }), BOT_ID)).toBe("precise");
  });
  it("returns dm in a DM", () => {
    expect(detectMentionKind(fakeMsg({ guildId: null }), BOT_ID)).toBe("dm");
  });
  it("returns reply_chain when replying to bot's earlier message", () => {
    expect(detectMentionKind(fakeMsg({ referencedAuthorId: BOT_ID }), BOT_ID)).toBe("reply_chain");
  });
  it("returns quoted when forwarded snapshot mentions the bot", () => {
    const msg = fakeMsg({ snapshots: [{ mentionedIds: [BOT_ID] }] });
    expect(detectMentionKind(msg, BOT_ID)).toBe("quoted");
  });
  it("returns quoted when forwarded snapshot content has <@bot>", () => {
    const msg = fakeMsg({ snapshots: [{ content: `hey <@${BOT_ID}> look` }] });
    expect(detectMentionKind(msg, BOT_ID)).toBe("quoted");
  });
  it("returns null when not addressed", () => {
    expect(detectMentionKind(fakeMsg(), BOT_ID)).toBeNull();
  });
});

describe("receiveDiscordMessage", () => {
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

  it("drops duplicate messages on second receive", async () => {
    const msg = fakeMsg({ mentionedIds: [BOT_ID] });
    await receiveDiscordMessage(msg, { gateway, dedupe, defaultAgentId: "main" }, ctx());
    await receiveDiscordMessage(msg, { gateway, dedupe, defaultAgentId: "main" }, ctx());
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
  });

  it("drops self-authored messages", async () => {
    const msg = fakeMsg({ authorId: BOT_ID });
    await receiveDiscordMessage(msg, { gateway, dedupe, defaultAgentId: "main" }, ctx());
    expect(gateway.dispatch).not.toHaveBeenCalled();
  });

  it("drops other bots by default", async () => {
    const msg = fakeMsg({ authorBot: true, mentionedIds: [BOT_ID] });
    await receiveDiscordMessage(msg, { gateway, dedupe, defaultAgentId: "main" }, ctx());
    expect(gateway.dispatch).not.toHaveBeenCalled();
  });

  it("respects allowBots=true", async () => {
    const msg = fakeMsg({ authorBot: true, mentionedIds: [BOT_ID] });
    await receiveDiscordMessage(
      msg,
      { gateway, dedupe, allowBots: true, defaultAgentId: "main" },
      ctx(),
    );
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
  });

  it("dispatches on precise @mention", async () => {
    const msg = fakeMsg({ mentionedIds: [BOT_ID], content: `<@${BOT_ID}> hi there` });
    await receiveDiscordMessage(msg, { gateway, dedupe, defaultAgentId: "main" }, ctx());
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    const [message, callbacks] = gateway.dispatch.mock.calls[0];
    expect(message).toMatchObject({
      agentId: "main",
      sessionKey: `discord:${BOT_ID}:channel:channel-1`,
      content: "hi there",
      source: "channel",
      sender: "alice",
    });
    expect(message.extraSystemPrompt).toContain("Chat Output Directives");
    expect(callbacks).toBe(cbObj);
    expect(buildCallbacks).toHaveBeenCalledWith(msg);
  });

  it("dispatches on DM regardless of mention", async () => {
    const msg = fakeMsg({ guildId: null });
    await receiveDiscordMessage(msg, { gateway, dedupe, defaultAgentId: "main" }, ctx());
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(gateway.dispatch.mock.calls[0][0].sessionKey).toBe(`discord:${BOT_ID}:dm:user-1`);
  });

  it("dispatches on reply-chain (user replies to bot)", async () => {
    const msg = fakeMsg({ referencedAuthorId: BOT_ID });
    await receiveDiscordMessage(msg, { gateway, dedupe, defaultAgentId: "main" }, ctx());
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
  });

  it("dispatches on quoted/forwarded snapshot mentioning bot", async () => {
    const msg = fakeMsg({ snapshots: [{ mentionedIds: [BOT_ID] }] });
    await receiveDiscordMessage(msg, { gateway, dedupe, defaultAgentId: "main" }, ctx());
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
  });

  it("drops guild messages with no mention when requireMention=true (default)", async () => {
    const msg = fakeMsg();
    await receiveDiscordMessage(msg, { gateway, dedupe, defaultAgentId: "main" }, ctx());
    expect(gateway.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches guild messages with no mention when requireMention=false", async () => {
    const msg = fakeMsg({ guildId: "g-1" });
    await receiveDiscordMessage(
      msg,
      {
        gateway,
        dedupe,
        defaultAgentId: "main",
        guilds: { "g-1": { requireMention: false } },
      },
      ctx(),
    );
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
  });

  it("routes via agentBindings when a bound user is mentioned", async () => {
    const msg = fakeMsg({ mentionedIds: ["222222"], guildId: "g-1" });
    await receiveDiscordMessage(
      msg,
      {
        gateway,
        dedupe,
        defaultAgentId: "fallback",
        agentBindings: { "222222": "alpha" },
        guilds: { "g-1": { requireMention: false } },
      },
      ctx(),
    );
    expect(gateway.dispatch.mock.calls[0][0].agentId).toBe("alpha");
  });

  it("uses thread session key when message is in a thread", async () => {
    const msg = fakeMsg({ threadId: "thr-42", mentionedIds: [BOT_ID] });
    await receiveDiscordMessage(msg, { gateway, dedupe, defaultAgentId: "main" }, ctx());
    expect(gateway.dispatch.mock.calls[0][0].sessionKey).toBe(`discord:${BOT_ID}:thread:thr-42`);
  });

  it("can disable dedupe via dedupeEnabled=false", async () => {
    const msg = fakeMsg({ mentionedIds: [BOT_ID] });
    const opts = { gateway, dedupe, defaultAgentId: "main", dedupeEnabled: false };
    await receiveDiscordMessage(msg, opts, ctx());
    await receiveDiscordMessage(msg, opts, ctx());
    expect(gateway.dispatch).toHaveBeenCalledTimes(2);
  });

  it("applies transformContent hook to dispatched content", async () => {
    const msg = fakeMsg({ mentionedIds: [BOT_ID], content: `<@${BOT_ID}> hi there` });
    const transform = vi.fn((content: string) => `<meta/>\n${content}`);
    await receiveDiscordMessage(
      msg,
      { gateway, dedupe, defaultAgentId: "main", transformContent: transform },
      ctx(),
    );
    expect(transform).toHaveBeenCalledWith("hi there", msg, "precise");
    expect(gateway.dispatch.mock.calls[0][0].content).toBe("<meta/>\nhi there");
  });

  it("calls flushRemaining on the callbacks after dispatch resolves", async () => {
    const gateway = makeGateway();
    const dedupe = new DedupeCache();
    const msg = fakeMsg({ content: "<@bot> hi", mentionedIds: ["bot"] });
    const flushRemaining = vi.fn().mockResolvedValue(undefined);
    const onTextDelta = vi.fn();
    const callbacks = { onTextDelta, flushRemaining };
    await receiveDiscordMessage(
      msg,
      { gateway, dedupe, defaultAgentId: "main" },
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
      receiveDiscordMessage(
        msg,
        { gateway, dedupe, defaultAgentId: "main" },
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
      receiveDiscordMessage(
        msg,
        { gateway, dedupe, defaultAgentId: "main" },
        { botId: "bot", buildCallbacks: () => callbacks },
      ),
    ).rejects.toThrow("boom");
    expect(flushRemaining).toHaveBeenCalledTimes(1);
  });
});
