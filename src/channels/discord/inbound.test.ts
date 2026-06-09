// src/channels/discord/receive.test.ts — Inbound pipeline tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message as DiscordMessage } from "discord.js";
import {
  handleInbound,
  handleStopCommand,
  passesAllowlist,
} from "./inbound.js";
import type { Gateway } from "../../gateway/index.js";
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
    dispatch: vi.fn().mockResolvedValue({ sessionId: "s", state: "new_run" }),
    dispatchAndWait: vi.fn().mockResolvedValue({ responseText: "", errorMessage: null }),
    abort: vi.fn().mockResolvedValue(undefined),
    abortByKey: vi.fn().mockResolvedValue(false),
    agentExists: vi.fn().mockReturnValue(true),
    listSessions: vi.fn().mockResolvedValue([]),
    listSessionsForAgent: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(() => {}),
    createOrResumeSession: vi.fn().mockResolvedValue({ sessionId: "s", sessionKey: "k", resumed: false }),
    deleteSession: vi.fn().mockResolvedValue(false),
  } as unknown as Gateway & { dispatch: ReturnType<typeof vi.fn> };
}

describe("handleInbound", () => {
  let gateway: ReturnType<typeof makeGateway>;
  let buildSubscriber: ReturnType<typeof vi.fn>;
  let inflight: Map<string, { onEvent: ReturnType<typeof vi.fn>; done: Promise<void> }>;

  beforeEach(() => {
    gateway = makeGateway();
    // Default subscriber: onEvent records calls; done resolves immediately so
    // handleInbound doesn't hang. Real outbound resolves done on agent_end.
    buildSubscriber = vi.fn().mockReturnValue({
      onEvent: vi.fn(),
      done: Promise.resolve(),
    });
    inflight = new Map();
  });

  const ctx = () => ({ botId: BOT_ID, buildSubscriber, inflight });
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

  it("drops self-authored messages", async () => {
    const msg = fakeMsg({ authorId: BOT_ID });
    await handleInbound(msg, route(msg), { gateway }, ctx());
    expect(gateway.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches other bots by default (allowBots default true)", async () => {
    const msg = fakeMsg({ authorBot: true, mentionedIds: [BOT_ID] });
    await handleInbound(msg, route(msg), { gateway }, ctx());
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
  });

  it("respects allowBots=false", async () => {
    const msg = fakeMsg({ authorBot: true, mentionedIds: [BOT_ID] });
    await handleInbound(msg, route(msg), { gateway, allowBots: false }, ctx());
    expect(gateway.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches on precise @mention", async () => {
    const msg = fakeMsg({ mentionedIds: [BOT_ID], content: `<@${BOT_ID}> hi there` });
    await handleInbound(msg, route(msg), { gateway }, ctx());
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    const [message] = gateway.dispatch.mock.calls[0];
    expect(message).toMatchObject({
      agentId: "main",
      sessionKey: `discord:${BOT_ID}:channel:channel-1`,
      content: "hi there",
      source: "channel",
      sender: "alice",
    });
    expect(message.extraSystemPrompt).toContain("Chat Reply Tags");
    expect(buildSubscriber).toHaveBeenCalledWith(msg);
    expect(gateway.subscribe).toHaveBeenCalled();
  });

  it("dispatches on DM regardless of mention", async () => {
    const msg = fakeMsg({ guildId: null });
    await handleInbound(msg, route(msg), { gateway }, ctx());
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(gateway.dispatch.mock.calls[0][0].sessionKey).toBe(`discord:${BOT_ID}:dm:user-1`);
  });

  it("drops guild messages with no mention when requireMention=true (default)", async () => {
    const msg = fakeMsg();
    await handleInbound(msg, route(msg), { gateway }, ctx());
    expect(gateway.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches guild messages with no mention when requireMention=false", async () => {
    const msg = fakeMsg({ guildId: "g-1" });
    await handleInbound(
      msg,
      route(msg),
      { gateway, guilds: { "g-1": { requireMention: false } } },
      ctx(),
    );
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
  });

  it("forwards routing.agentId to dispatch", async () => {
    const msg = fakeMsg({ mentionedIds: ["222222"], guildId: "g-1" });
    await handleInbound(
      msg,
      { agentId: "alpha", sessionKey: sessionKeyFor(msg) },
      { gateway, guilds: { "g-1": { requireMention: false } } },
      ctx(),
    );
    expect(gateway.dispatch.mock.calls[0][0].agentId).toBe("alpha");
  });

  it("uses thread session key when message is in a thread", async () => {
    const msg = fakeMsg({ threadId: "thr-42", mentionedIds: [BOT_ID] });
    await handleInbound(msg, route(msg), { gateway }, ctx());
    expect(gateway.dispatch.mock.calls[0][0].sessionKey).toBe(`discord:${BOT_ID}:thread:thr-42`);
  });

  it("drops thread messages when respondInThreads=false for the guild", async () => {
    const msg = fakeMsg({ threadId: "thr-x", guildId: "g-1", mentionedIds: [BOT_ID] });
    await handleInbound(
      msg,
      route(msg),
      { gateway, guilds: { "g-1": { respondInThreads: false } } },
      ctx(),
    );
    expect(gateway.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches thread messages when respondInThreads=true (default)", async () => {
    const msg = fakeMsg({ threadId: "thr-y", guildId: "g-1", mentionedIds: [BOT_ID] });
    await handleInbound(msg, route(msg), { gateway }, ctx());
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
  });

  it("applies transformContent hook to dispatched content", async () => {
    const msg = fakeMsg({ mentionedIds: [BOT_ID], content: `<@${BOT_ID}> hi there` });
    const transform = vi.fn((content: string) => `<meta/>\n${content}`);
    await handleInbound(
      msg,
      route(msg),
      { gateway, transformContent: transform },
      ctx(),
    );
    expect(transform).toHaveBeenCalledWith("hi there", msg);
    expect(gateway.dispatch.mock.calls[0][0].content).toBe("<meta/>\nhi there");
  });

  it("awaits subscriber.done after dispatch (new_run)", async () => {
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const onEvent = vi.fn();
    buildSubscriber = vi.fn().mockReturnValue({ onEvent, done });

    const msg = fakeMsg({ mentionedIds: [BOT_ID], content: `<@${BOT_ID}> hi` });
    const promise = handleInbound(msg, route(msg), { gateway }, ctx());
    // dispatch resolves first; handleInbound is now awaiting subscriber.done
    await new Promise((r) => setTimeout(r, 10));
    let settled = false;
    void promise.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    resolveDone();
    await promise;
    expect(settled).toBe(true);
  });

  it("awaits subscriber.done even when dispatch returns steered", async () => {
    gateway.dispatch.mockResolvedValueOnce({ sessionId: "s", state: "steered" });
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    buildSubscriber = vi.fn().mockReturnValue({ onEvent: vi.fn(), done });
    const msg = fakeMsg({ mentionedIds: [BOT_ID], content: `<@${BOT_ID}> hi` });
    let resolved = false;
    const p = handleInbound(msg, route(msg), { gateway }, ctx()).then(() => { resolved = true; });
    await vi.waitFor(() => expect(gateway.dispatch).toHaveBeenCalled());
    expect(resolved).toBe(false);
    resolveDone();
    await p;
    expect(resolved).toBe(true);
  });

  // Regression #865: concurrent messages on the same session must share one
  // outbound subscriber; otherwise gateway's fan-out emits each text_delta
  // N times and assistant text appears duplicated N× on Discord.
  it("coalesces concurrent inbound messages on same session to one subscriber", async () => {
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const onEvent = vi.fn();
    buildSubscriber = vi.fn().mockReturnValue({ onEvent, done });

    const msg1 = fakeMsg({ id: "m-1", mentionedIds: [BOT_ID], content: `<@${BOT_ID}> first` });
    const msg2 = fakeMsg({ id: "m-2", mentionedIds: [BOT_ID], content: `<@${BOT_ID}> second` });
    const msg3 = fakeMsg({ id: "m-3", mentionedIds: [BOT_ID], content: `<@${BOT_ID}> third` });

    const sharedCtx = ctx();
    const p1 = handleInbound(msg1, route(msg1), { gateway }, sharedCtx);
    // Let msg1 register the subscriber before msg2/msg3 arrive.
    await vi.waitFor(() => expect(buildSubscriber).toHaveBeenCalledTimes(1));
    const p2 = handleInbound(msg2, route(msg2), { gateway }, sharedCtx);
    const p3 = handleInbound(msg3, route(msg3), { gateway }, sharedCtx);

    await vi.waitFor(() => expect(gateway.dispatch).toHaveBeenCalledTimes(3));

    // Only ONE subscriber was built and subscribed despite 3 inbound messages.
    expect(buildSubscriber).toHaveBeenCalledTimes(1);
    expect(gateway.subscribe).toHaveBeenCalledTimes(1);

    // All three inbound messages were dispatched (so the model sees all of them).
    expect(gateway.dispatch.mock.calls[0][0].content).toContain("first");
    expect(gateway.dispatch.mock.calls[1][0].content).toContain("second");
    expect(gateway.dispatch.mock.calls[2][0].content).toContain("third");

    resolveDone();
    await Promise.all([p1, p2, p3]);
    // Inflight cleared after the shared subscriber resolves.
    expect(sharedCtx.inflight.size).toBe(0);
  });

  it("rebuilds subscriber for the next inbound after the first run completes", async () => {
    // First batch: one message, resolves to done.
    let resolveDone1!: () => void;
    const done1 = new Promise<void>((r) => { resolveDone1 = r; });
    buildSubscriber = vi
      .fn()
      .mockReturnValueOnce({ onEvent: vi.fn(), done: done1 })
      .mockReturnValueOnce({ onEvent: vi.fn(), done: Promise.resolve() });

    const sharedCtx = ctx();
    const msg1 = fakeMsg({ id: "m-1", mentionedIds: [BOT_ID], content: `<@${BOT_ID}> first` });
    const p1 = handleInbound(msg1, route(msg1), { gateway }, sharedCtx);
    await vi.waitFor(() => expect(buildSubscriber).toHaveBeenCalledTimes(1));
    resolveDone1();
    await p1;
    expect(sharedCtx.inflight.size).toBe(0);

    // Second batch: a new message after the first run finished should build
    // a fresh subscriber, not reuse the disposed one.
    const msg2 = fakeMsg({ id: "m-2", mentionedIds: [BOT_ID], content: `<@${BOT_ID}> second` });
    await handleInbound(msg2, route(msg2), { gateway }, sharedCtx);
    expect(buildSubscriber).toHaveBeenCalledTimes(2);
    expect(gateway.subscribe).toHaveBeenCalledTimes(2);
  });
});

describe("passesAllowlist (allowlist policy)", () => {
  const account = (groupAccess: DiscordAccountConfig["groupAccess"]): DiscordAccountConfig => ({
    token: "t",
    defaultAgentId: "main",
    groupAccess,
  } as DiscordAccountConfig);

  it("drops when allowlist policy has no rules (fail-closed)", () => {
    const msg = fakeMsg({ guildId: "g-1" });
    expect(passesAllowlist(msg, account({ policy: "allowlist" } as never))).toBe(false);
  });

  it("rejects when guild not in guildAllowlist", () => {
    const msg = fakeMsg({ guildId: "g-1" });
    expect(passesAllowlist(msg, account({ policy: "allowlist", guildAllowlist: ["g-2"] } as never))).toBe(false);
  });

  it("accepts when guild is in guildAllowlist", () => {
    const msg = fakeMsg({ guildId: "g-1" });
    expect(passesAllowlist(msg, account({ policy: "allowlist", guildAllowlist: ["g-1"] } as never))).toBe(true);
  });

  it("accepts thread when parent channel is in channelAllowlist", () => {
    const msg = fakeMsg({
      guildId: "g-1",
      threadId: "thr-1",
      parentChannelId: "parent-c",
    });
    const result = passesAllowlist(
      msg,
      account({ policy: "allowlist", guildAllowlist: ["g-1"], channelAllowlist: ["parent-c"] } as never),
    );
    expect(result).toBe(true);
  });
});

describe("handleStopCommand", () => {
  function makeStopGateway() {
    return {
      ...makeGateway(),
      abortByKey: vi.fn().mockResolvedValue(true),
      abort: vi.fn().mockResolvedValue(undefined),
    } as unknown as Gateway & { abort: ReturnType<typeof vi.fn>; abortByKey: ReturnType<typeof vi.fn> };
  }

  it("returns false when message is not /stop", async () => {
    const msg = fakeMsg({ content: "hello" });
    expect(await handleStopCommand(msg, BOT_ID, makeStopGateway(), "main", "k")).toBe(false);
  });

  it("aborts and confirms on /stop in DM", async () => {
    const channelSend = vi.fn().mockResolvedValue(undefined);
    const msg = {
      ...fakeMsg({ content: "/stop", guildId: null }),
      channel: { send: channelSend },
    } as unknown as DiscordMessage;
    const gw = makeStopGateway();
    expect(await handleStopCommand(msg, BOT_ID, gw, "main", "k")).toBe(true);
    expect(gw.abortByKey).toHaveBeenCalledWith("main", "k", "user");
    expect(channelSend).toHaveBeenCalled();
  });
});
