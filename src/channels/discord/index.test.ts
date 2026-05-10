// src/channels/discord/index.test.ts — ChannelAdapter lifecycle + wiring tests.
//
// We don't exercise discord.js at all — instead inject a fake Client via the
// `clientFactory` test seam so we can assert on login/destroy and drive
// messageCreate manually.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message as DiscordMessage } from "discord.js";
import { createDiscordChannel, type ClientLike } from "./index.js";
import type { Gateway } from "../../gateway/index.js";
import type { Logger } from "../../logging/logger.js";
import { LazyChannelContext } from "../../channels/channel-context.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeClient extends ClientLike {
  handlers: Map<string, Array<(...args: unknown[]) => void>>;
  emit(event: string, ...args: unknown[]): void;
  loginMock: ReturnType<typeof vi.fn>;
  destroyMock: ReturnType<typeof vi.fn>;
}

function makeFakeClient(botId: string): FakeClient {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const loginMock = vi.fn().mockResolvedValue(undefined);
  const destroyMock = vi.fn();
  const client: FakeClient = {
    user: { id: botId, tag: `bot#${botId}` },
    channels: { fetch: vi.fn().mockResolvedValue(null), cache: new Map() },
    handlers,
    on(event, handler) {
      const arr = handlers.get(event) ?? [];
      arr.push(handler);
      handlers.set(event, arr);
      return this;
    },
    emit(event, ...args) {
      for (const h of handlers.get(event) ?? []) h(...args);
    },
    login: loginMock,
    destroy: destroyMock,
    loginMock,
    destroyMock,
  };
  return client;
}

function makeGateway(): Gateway & {
  dispatch: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
} {
  return {
    dispatch: vi.fn().mockResolvedValue({
      sessionId: "s",
      state: "started",
      responseText: "",
      errorMessage: null,
    }),
    abort: vi.fn().mockResolvedValue(undefined),
    abortByKey: vi.fn().mockResolvedValue(false),
  } as Gateway & {
    dispatch: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    abortByKey: ReturnType<typeof vi.fn>;
  };
}

function silentLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

interface FakeMsgOpts {
  id?: string;
  channelId?: string;
  authorId?: string;
  authorBot?: boolean;
  guildId?: string | null;
  content?: string;
  mentionedIds?: string[];
}

function fakeMsg(opts: FakeMsgOpts = {}): DiscordMessage {
  const mentionedIds = new Set(opts.mentionedIds ?? []);
  const guild = opts.guildId === null ? null : { id: opts.guildId ?? "guild-1" };
  const channel = {
    send: vi.fn().mockResolvedValue({ id: "out-1" }),
  };
  return {
    id: opts.id ?? "msg-1",
    channelId: opts.channelId ?? "channel-1",
    content: opts.content ?? "<@bot> hello",
    createdTimestamp: 1700000000000,
    author: {
      id: opts.authorId ?? "user-1",
      username: "alice",
      bot: opts.authorBot ?? false,
    },
    guild,
    thread: null,
    mentions: { has: (id: string) => mentionedIds.has(id) },
    channel,
    reply: vi.fn().mockResolvedValue({ id: "out-1" }),
  } as unknown as DiscordMessage;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDiscordChannel — lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no-ops when no accounts configured", async () => {
    const adapter = createDiscordChannel({});
    const logger = silentLogger();
    await adapter.start({ gateway: makeGateway(), config: {}, logger });
    await adapter.stop();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no accounts"));
  });

  it("constructs and logs in one client per account", async () => {
    const a = makeFakeClient("bot-A");
    const b = makeFakeClient("bot-B");
    const factories = [a, b];
    const adapter = createDiscordChannel(
      {
        accounts: {
          alpha: { token: "tok-a", defaultAgentId: "agent-a", groupAccess: { policy: "open" } },
          beta: { token: "tok-b", defaultAgentId: "agent-b", groupAccess: { policy: "open" } },
        },
      },
      { clientFactory: () => factories.shift()! },
    );
    await adapter.start({ gateway: makeGateway(), config: {}, logger: silentLogger() });
    expect(a.loginMock).toHaveBeenCalledWith("tok-a");
    expect(b.loginMock).toHaveBeenCalledWith("tok-b");
    await adapter.stop();
    expect(a.destroyMock).toHaveBeenCalled();
    expect(b.destroyMock).toHaveBeenCalled();
  });

  it("skips accounts with no token / tokenEnv", async () => {
    const c = makeFakeClient("bot-X");
    const adapter = createDiscordChannel(
      { accounts: { x: { defaultAgentId: "agent-x" } } },
      { clientFactory: () => c },
    );
    const logger = silentLogger();
    await adapter.start({ gateway: makeGateway(), config: {}, logger });
    expect(c.loginMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no token"));
  });

  it("binds itself as a Channel into per-agent channel contexts so message_react works", async () => {
    const client = makeFakeClient("bot-A");
    const adapter = createDiscordChannel(
      { accounts: { acct1: { token: "tok", defaultAgentId: "main", groupAccess: { policy: "open" } } } },
      { clientFactory: () => client },
    );
    const ctx = new LazyChannelContext();
    const channelContexts = new Map([["main", ctx]]);
    await adapter.start({ gateway: makeGateway(), config: {}, logger: silentLogger(), channelContexts });

    const channel = ctx.getChannel();
    expect(channel).toBeDefined();
    expect(typeof channel!.react).toBe("function");
  });

  it("wraps inbound dispatch in A2A sink factory for spawn_agent threads", async () => {
    const { getA2ASinkFactory } = await import("../../agent/a2a-sink.js");
    const client = makeFakeClient("bot-A");
    let observed: ReturnType<typeof getA2ASinkFactory>;
    const gateway = makeGateway();
    gateway.dispatch.mockImplementation(async () => {
      observed = getA2ASinkFactory();
      return { sessionId: "s", state: "started", responseText: "", errorMessage: null };
    });
    const adapter = createDiscordChannel(
      { accounts: { acct: { token: "t", defaultAgentId: "main", groupAccess: { policy: "open" } } } },
      { clientFactory: () => client },
    );
    await adapter.start({ gateway, config: {}, logger: silentLogger() });
    client.emit("messageCreate", fakeMsg({ mentionedIds: ["bot-A"] }));
    await new Promise((r) => setImmediate(r));
    expect(observed).toBeDefined();
    expect(typeof observed).toBe("function");
    const sink = observed!();
    expect(typeof sink.start).toBe("function");
    expect(typeof sink.send).toBe("function");
    expect(typeof sink.finish).toBe("function");
  });
});

describe("createDiscordChannel — inbound wiring", () => {
  it("messageCreate routes through allowlist + receive into gateway.dispatch", async () => {
    const client = makeFakeClient("bot-A");
    const gateway = makeGateway();
    const adapter = createDiscordChannel(
      {
        accounts: {
          alpha: {
            token: "tok",
            defaultAgentId: "main",
            groupAccess: { policy: "allowlist", channelAllowlist: ["channel-1"] },
          },
        },
      },
      { clientFactory: () => client },
    );
    await adapter.start({ gateway, config: {}, logger: silentLogger() });

    const msg = fakeMsg({ mentionedIds: ["bot-A"] });
    client.emit("messageCreate", msg);
    // Allow microtask queue to flush async handler
    await new Promise((r) => setImmediate(r));

    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    const [message] = gateway.dispatch.mock.calls[0];
    expect(message.agentId).toBe("main");
    expect(message.sessionKey).toBe("discord:bot-A:channel:channel-1");
  });

  it("drops guild messages outside the allowlist", async () => {
    const client = makeFakeClient("bot-A");
    const gateway = makeGateway();
    const adapter = createDiscordChannel(
      {
        accounts: {
          alpha: {
            token: "tok",
            defaultAgentId: "main",
            groupAccess: { policy: "allowlist", channelAllowlist: ["other"] },
          },
        },
      },
      { clientFactory: () => client },
    );
    await adapter.start({ gateway, config: {}, logger: silentLogger() });
    client.emit("messageCreate", fakeMsg({ mentionedIds: ["bot-A"] }));
    await new Promise((r) => setImmediate(r));
    expect(gateway.dispatch).not.toHaveBeenCalled();
  });

  it("multi-bot: each account routes to its own agent", async () => {
    const a = makeFakeClient("bot-A");
    const b = makeFakeClient("bot-B");
    const factories = [a, b];
    const gateway = makeGateway();
    const adapter = createDiscordChannel(
      {
        accounts: {
          alpha: { token: "ta", defaultAgentId: "agent-a", groupAccess: { policy: "open" } },
          beta: { token: "tb", defaultAgentId: "agent-b", groupAccess: { policy: "open" } },
        },
      },
      { clientFactory: () => factories.shift()! },
    );
    await adapter.start({ gateway, config: {}, logger: silentLogger() });

    a.emit("messageCreate", fakeMsg({ id: "m-a", mentionedIds: ["bot-A"] }));
    b.emit("messageCreate", fakeMsg({ id: "m-b", mentionedIds: ["bot-B"] }));
    await new Promise((r) => setImmediate(r));

    expect(gateway.dispatch).toHaveBeenCalledTimes(2);
    const agents = gateway.dispatch.mock.calls.map((c) => c[0].agentId).sort();
    expect(agents).toEqual(["agent-a", "agent-b"]);
  });

  it("invokes flushRemaining via the receive→outbound bridge", async () => {
    // The OutboundCallbacks built by createDiscordCallbacks expose
    // flushRemaining; receive.ts now calls it post-dispatch. We simulate a
    // text_delta by having gateway.dispatch invoke onTextDelta on the
    // callbacks it receives, then assert the channel was sent to.
    const client = makeFakeClient("bot-A");
    const gateway = makeGateway();
    gateway.dispatch.mockImplementation(async (_msg, cb) => {
      cb?.onTextDelta?.("hello world.");
      return { sessionId: "s", state: "started", responseText: "", errorMessage: null };
    });
    const adapter = createDiscordChannel(
      {
        accounts: {
          alpha: { token: "tok", defaultAgentId: "main", groupAccess: { policy: "open" } },
        },
      },
      { clientFactory: () => client },
    );
    await adapter.start({ gateway, config: {}, logger: silentLogger() });

    const msg = fakeMsg({ mentionedIds: ["bot-A"] });
    client.emit("messageCreate", msg);
    // Allow async chain (handleInbound → receive → dispatch → flushRemaining) to settle
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Without a reply directive the chunk is sent via channel.send (not reply()).
    const channelSend = (msg.channel as unknown as { send: ReturnType<typeof vi.fn> }).send;
    expect(channelSend).toHaveBeenCalled();
    expect(channelSend.mock.calls[0][0]).toContain("hello world.");
  });
});

describe("createDiscordChannel — DM raw packet workaround", () => {
  it("fetches and dispatches DM messages arriving via raw MESSAGE_CREATE", async () => {
    const client = makeFakeClient("bot-A");
    // Add channels.fetch to the fake client
    const fetchedMsg = fakeMsg({
      id: "dm-1",
      channelId: "dm-chan",
      authorId: "user-9",
      guildId: null,
    });
    const messagesFetch = vi.fn().mockResolvedValue(fetchedMsg);
    const channelsFetch = vi.fn().mockResolvedValue({
      isTextBased: () => true,
      messages: { fetch: messagesFetch },
    });
    (client as unknown as { channels: { fetch: typeof channelsFetch } }).channels = {
      fetch: channelsFetch,
    };

    const gateway = makeGateway();
    const adapter = createDiscordChannel(
      {
        accounts: {
          alpha: {
            token: "tok",
            defaultAgentId: "main",
            dmAccess: { policy: "allowlist", allowlist: ["user-9"] },
          },
        },
      },
      { clientFactory: () => client },
    );
    await adapter.start({ gateway, config: {}, logger: silentLogger() });

    client.emit("raw", { t: "MESSAGE_CREATE", d: { id: "dm-1", channel_id: "dm-chan" } });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(channelsFetch).toHaveBeenCalledWith("dm-chan");
    expect(messagesFetch).toHaveBeenCalledWith("dm-1");
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(gateway.dispatch.mock.calls[0][0].sessionKey).toBe("discord:bot-A:dm:user-9");
  });

  it("ignores raw MESSAGE_CREATE for guild messages", async () => {
    const client = makeFakeClient("bot-A");
    const channelsFetch = vi.fn();
    (client as unknown as { channels: { fetch: typeof channelsFetch } }).channels = {
      fetch: channelsFetch,
    };
    const gateway = makeGateway();
    const adapter = createDiscordChannel(
      { accounts: { alpha: { token: "tok", defaultAgentId: "main" } } },
      { clientFactory: () => client },
    );
    await adapter.start({ gateway, config: {}, logger: silentLogger() });

    client.emit("raw", {
      t: "MESSAGE_CREATE",
      d: { id: "x", channel_id: "y", guild_id: "g" },
    });
    await new Promise((r) => setImmediate(r));
    expect(channelsFetch).not.toHaveBeenCalled();
  });
});

describe("createDiscordChannel — message metadata enrichment", () => {
  it("prepends inbound_meta block to dispatched content", async () => {
    const client = makeFakeClient("bot-A");
    const gateway = makeGateway();
    const adapter = createDiscordChannel(
      {
        accounts: {
          alpha: {
            token: "tok",
            defaultAgentId: "main",
            groupAccess: { policy: "open" },
          },
        },
      },
      { clientFactory: () => client },
    );
    await adapter.start({ gateway, config: {}, logger: silentLogger() });

    const msg = fakeMsg({
      mentionedIds: ["bot-A"],
      content: "<@bot-A> hello",
      authorId: "user-42",
    });
    // The metadata extractor reads msg.channel.type / .name; provide minimal shape.
    (msg.channel as unknown as { type: number; name: string }).type = 0;
    (msg.channel as unknown as { type: number; name: string }).name = "general";

    client.emit("messageCreate", msg);
    await new Promise((r) => setImmediate(r));

    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    const dispatched = gateway.dispatch.mock.calls[0][0];
    expect(dispatched.content).toContain("<inbound_meta");
    expect(dispatched.content).toContain("<sender_id>user-42</sender_id>");
    expect(dispatched.content).toContain("<chat_type>group</chat_type>");
    expect(dispatched.content).toContain("hello");
  });
});

describe("createDiscordChannel — /stop interception", () => {
  it("/stop in a guild channel with @mention aborts via gateway", async () => {
    const client = makeFakeClient("bot-A");
    const gateway = makeGateway();
    const adapter = createDiscordChannel(
      {
        accounts: {
          alpha: {
            token: "tok",
            defaultAgentId: "main",
            groupAccess: { policy: "open" },
          },
        },
      },
      { clientFactory: () => client },
    );
    await adapter.start({ gateway, config: {}, logger: silentLogger() });

    const msg = fakeMsg({ content: "<@bot-A> /stop", mentionedIds: ["bot-A"] });
    client.emit("messageCreate", msg);
    await new Promise((r) => setImmediate(r));

    expect(gateway.abortByKey).toHaveBeenCalledWith("main", "discord:bot-A:channel:channel-1", "user");
    expect(gateway.dispatch).not.toHaveBeenCalled();
  });

  it("/stop in a guild channel without @mention is consumed but not aborted", async () => {
    const client = makeFakeClient("bot-A");
    const gateway = makeGateway();
    const adapter = createDiscordChannel(
      {
        accounts: {
          alpha: {
            token: "tok",
            defaultAgentId: "main",
            groupAccess: { policy: "open" },
          },
        },
      },
      { clientFactory: () => client },
    );
    await adapter.start({ gateway, config: {}, logger: silentLogger() });

    const msg = fakeMsg({ content: "/stop" }); // no mention
    client.emit("messageCreate", msg);
    await new Promise((r) => setImmediate(r));
    expect(gateway.abort).not.toHaveBeenCalled();
    expect(gateway.dispatch).not.toHaveBeenCalled();
  });
});
