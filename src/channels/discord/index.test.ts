import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message as DiscordMessage } from "discord.js";
import { createDiscordChannel, type ClientLike } from "./index.js";
import type { Gateway } from "../../gateway/index.js";
import { LazyChannelContext } from "../../channels/types.js";

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
  abortByKey: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
} {
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
  } as unknown as Gateway & {
    dispatch: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    abortByKey: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
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

describe("createDiscordChannel — lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no-ops when no accounts configured", async () => {
    const adapter = createDiscordChannel({});
    await adapter.start({ gateway: makeGateway() });
    await adapter.stop();
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
    await adapter.start({ gateway: makeGateway() });
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
    await adapter.start({ gateway: makeGateway() });
    expect(c.loginMock).not.toHaveBeenCalled();
  });

  it("binds itself as a Channel into per-agent channel contexts so message_react works", async () => {
    const client = makeFakeClient("bot-A");
    const adapter = createDiscordChannel(
      { accounts: { acct1: { token: "tok", defaultAgentId: "main", groupAccess: { policy: "open" } } } },
      { clientFactory: () => client },
    );
    const ctx = new LazyChannelContext();
    const channelContexts = new Map([["main", ctx]]);
    await adapter.start({ gateway: makeGateway(), channelContexts });

    const channel = ctx.getChannelActions();
    expect(channel).toBeDefined();
    expect(typeof channel!.react).toBe("function");
  });

  it("per-agent react binding: agent A's react uses bot A only, not bot B", async () => {
    const msgA = { id: "msg-1", react: vi.fn().mockResolvedValue(undefined) };
    const msgB = { id: "msg-1", react: vi.fn().mockResolvedValue(undefined) };
    const clientA = makeFakeClient("bot-A");
    const clientB = makeFakeClient("bot-B");
    // Both bots could fetch the channel; routing must pick A.
    clientA.channels.fetch = vi.fn().mockResolvedValue({
      messages: { fetch: vi.fn().mockResolvedValue(msgA) },
    });
    clientB.channels.fetch = vi.fn().mockResolvedValue({
      messages: { fetch: vi.fn().mockResolvedValue(msgB) },
    });
    const factories = [clientA, clientB];
    const adapter = createDiscordChannel(
      {
        accounts: {
          a: { token: "ta", defaultAgentId: "agentA", groupAccess: { policy: "open" } },
          b: { token: "tb", defaultAgentId: "agentB", groupAccess: { policy: "open" } },
        },
      },
      { clientFactory: () => factories.shift()! },
    );
    const ctxA = new LazyChannelContext();
    const ctxB = new LazyChannelContext();
    await adapter.start({
      gateway: makeGateway(),
      
      channelContexts: new Map([["agentA", ctxA], ["agentB", ctxB]]),
    });
    await ctxA.getChannelActions()!.react!("msg-1", "👀", "ch-1");
    expect(msgA.react).toHaveBeenCalledWith("👀");
    expect(msgB.react).not.toHaveBeenCalled();
  });

  it("wraps inbound dispatch in A2A sink factory for spawn_agent threads", async () => {
    const { getA2ASinkFactory } = await import("../../agent/a2a-sink.js");
    const client = makeFakeClient("bot-A");
    let observed: ReturnType<typeof getA2ASinkFactory>;
    const gateway = makeGateway();
    gateway.dispatch.mockImplementation(async () => {
      observed = getA2ASinkFactory();
      return { sessionId: "s", state: "new_run", responseText: "", errorMessage: null };
    });
    const adapter = createDiscordChannel(
      { accounts: { acct: { token: "t", defaultAgentId: "main", groupAccess: { policy: "open" } } } },
      { clientFactory: () => client },
    );
    await adapter.start({ gateway });
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
    await adapter.start({ gateway });

    const msg = fakeMsg({ mentionedIds: ["bot-A"] });
    client.emit("messageCreate", msg);
    await new Promise((r) => setImmediate(r));

    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    const [message] = gateway.dispatch.mock.calls[0];
    expect(message.agentId).toBe("main");
    expect(message.sessionKey).toBe("discord:bot-A:channel:channel-1");
  });

  it("dedupes a replayed message (WS RESUME) — same id only dispatches once", async () => {
    const client = makeFakeClient("bot-A");
    const gateway = makeGateway();
    const adapter = createDiscordChannel(
      {
        accounts: {
          alpha: { token: "tok", defaultAgentId: "main", groupAccess: { policy: "open" } },
        },
      },
      { clientFactory: () => client },
    );
    await adapter.start({ gateway });

    const msg = fakeMsg({ id: "dup-1", mentionedIds: ["bot-A"] });
    client.emit("messageCreate", msg);
    client.emit("messageCreate", msg);
    await new Promise((r) => setImmediate(r));

    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
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
    await adapter.start({ gateway });
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
    await adapter.start({ gateway });

    a.emit("messageCreate", fakeMsg({ id: "m-a", mentionedIds: ["bot-A"] }));
    b.emit("messageCreate", fakeMsg({ id: "m-b", mentionedIds: ["bot-B"] }));
    await new Promise((r) => setImmediate(r));

    expect(gateway.dispatch).toHaveBeenCalledTimes(2);
    const agents = gateway.dispatch.mock.calls.map((c) => c[0].agentId).sort();
    expect(agents).toEqual(["agent-a", "agent-b"]);
  });

  it("routes text_delta events into Discord via subscribe", async () => {
    const client = makeFakeClient("bot-A");
    const gateway = makeGateway();
    // Capture the subscriber so we can fire events into it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedListener: ((event: any) => void) | undefined;
    gateway.subscribe.mockImplementation(async (_a, _k, listener) => {
      capturedListener = listener;
      return () => {};
    });
    const adapter = createDiscordChannel(
      {
        accounts: {
          alpha: { token: "tok", defaultAgentId: "main", groupAccess: { policy: "open" } },
        },
      },
      { clientFactory: () => client },
    );
    await adapter.start({ gateway });

    const msg = fakeMsg({ mentionedIds: ["bot-A"] });
    client.emit("messageCreate", msg);
    // Allow handleInbound to run through createOrResumeSession → subscribe → dispatch.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(capturedListener).toBeDefined();
    capturedListener!({ type: "text_delta", delta: "hello world." });
    capturedListener!({ type: "agent_end", stopReason: "end" });
    // Let the subscriber's async agent_end flush run.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const channelSend = (msg.channel as unknown as { send: ReturnType<typeof vi.fn> }).send;
    expect(channelSend).toHaveBeenCalled();
    expect(channelSend.mock.calls[0][0]).toContain("hello world.");
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
    await adapter.start({ gateway });

    const msg = fakeMsg({
      mentionedIds: ["bot-A"],
      content: "<@bot-A> hello",
      authorId: "user-42",
    });
    // extractDiscordMetadata reads channel.type / .name.
    (msg.channel as unknown as { type: number; name: string }).type = 0;
    (msg.channel as unknown as { type: number; name: string }).name = "general";

    client.emit("messageCreate", msg);
    await new Promise((r) => setImmediate(r));

    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    const dispatched = gateway.dispatch.mock.calls[0][0];
    expect(dispatched.content).toContain("[Discord untrusted group");
    expect(dispatched.content).toContain("from=alice/user-42");
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
    await adapter.start({ gateway });

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
    await adapter.start({ gateway });

    const msg = fakeMsg({ content: "/stop" }); // no mention
    client.emit("messageCreate", msg);
    await new Promise((r) => setImmediate(r));
    expect(gateway.abort).not.toHaveBeenCalled();
    expect(gateway.dispatch).not.toHaveBeenCalled();
  });
});

describe("createDiscordChannel — outbound (send + fetchHistory)", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function singleAccountAdapter() {
    const client = makeFakeClient("bot-A");
    const adapter = createDiscordChannel(
      { accounts: { acct1: { token: "tok", defaultAgentId: "main", groupAccess: { policy: "open" } } } },
      { clientFactory: () => client },
    );
    return { client, adapter };
  }

  it("send: posts to channelId and returns the message id", async () => {
    const { client, adapter } = singleAccountAdapter();
    const sendMock = vi.fn().mockResolvedValue({ id: "out-1" });
    client.channels.fetch = vi.fn().mockResolvedValue({ send: sendMock });

    await adapter.start({ gateway: makeGateway() });
    const out = await adapter.send({ accountId: "acct1", channelId: "ch-1" }, "hi");

    expect(client.channels.fetch).toHaveBeenCalledWith("ch-1");
    expect(sendMock).toHaveBeenCalledWith("hi");
    expect(out).toEqual({ id: "out-1" });

    await adapter.stop();
  });

  it("send: posts to threadId when provided", async () => {
    const { client, adapter } = singleAccountAdapter();
    const sendMock = vi.fn().mockResolvedValue({ id: "out-2" });
    client.channels.fetch = vi.fn().mockResolvedValue({ send: sendMock });

    await adapter.start({ gateway: makeGateway() });
    await adapter.send({ accountId: "acct1", channelId: "ch-1", threadId: "thr-9" }, "hi");

    expect(client.channels.fetch).toHaveBeenCalledWith("thr-9");
    await adapter.stop();
  });

  it("send: throws on unknown accountId", async () => {
    const { adapter } = singleAccountAdapter();
    await adapter.start({ gateway: makeGateway() });
    await expect(adapter.send({ accountId: "nope", channelId: "ch-1" }, "hi"))
      .rejects.toThrow(/unknown discord accountid/i);
    await adapter.stop();
  });

  it("send: throws when the channel isn't sendable", async () => {
    const { client, adapter } = singleAccountAdapter();
    client.channels.fetch = vi.fn().mockResolvedValue({ /* no send */ });
    await adapter.start({ gateway: makeGateway() });
    await expect(adapter.send({ accountId: "acct1", channelId: "ch-1" }, "hi"))
      .rejects.toThrow(/not sendable/);
    await adapter.stop();
  });

  it("send: truncates payloads over 2000 chars with a trailing marker", async () => {
    const { client, adapter } = singleAccountAdapter();
    const sendMock = vi.fn().mockResolvedValue({ id: "out-trunc" });
    client.channels.fetch = vi.fn().mockResolvedValue({ send: sendMock });
    await adapter.start({ gateway: makeGateway() });

    const huge = "x".repeat(5000);
    await adapter.send({ accountId: "acct1", channelId: "ch-1" }, huge);

    const payload = sendMock.mock.calls[0]![0] as string;
    expect(payload.length).toBeLessThanOrEqual(2000);
    expect(payload.endsWith("…(truncated)")).toBe(true);
    await adapter.stop();
  });

  it("send: leaves short payloads untouched", async () => {
    const { client, adapter } = singleAccountAdapter();
    const sendMock = vi.fn().mockResolvedValue({ id: "out-short" });
    client.channels.fetch = vi.fn().mockResolvedValue({ send: sendMock });
    await adapter.start({ gateway: makeGateway() });
    await adapter.send({ accountId: "acct1", channelId: "ch-1" }, "small");
    expect(sendMock).toHaveBeenCalledWith("small");
    await adapter.stop();
  });

  it("fetchHistory: returns oldest-first entries, clamps limit to [1,100]", async () => {
    const { client, adapter } = singleAccountAdapter();
    const fetched = new Map([
      ["m2", { id: "m2", author: { username: "bob" }, content: "world", createdTimestamp: 200 }],
      ["m1", { id: "m1", author: { username: "alice" }, content: "hello", createdTimestamp: 100 }],
    ]);
    const fetchMessages = vi.fn().mockResolvedValue(fetched);
    client.channels.fetch = vi.fn().mockResolvedValue({ messages: { fetch: fetchMessages } });

    await adapter.start({ gateway: makeGateway() });
    const entries = await adapter.fetchHistory({ accountId: "acct1", channelId: "ch-1" }, { limit: 999 });

    expect(fetchMessages).toHaveBeenCalledWith({ limit: 100 });
    expect(entries.map((e) => e.messageId)).toEqual(["m1", "m2"]);
    expect(entries[0]).toMatchObject({ sender: "alice", body: "hello", timestamp: 100 });

    await adapter.stop();
  });

  it("fetchHistory: throws on unknown accountId", async () => {
    const { adapter } = singleAccountAdapter();
    await adapter.start({ gateway: makeGateway() });
    await expect(adapter.fetchHistory({ accountId: "nope", channelId: "ch-1" }, { limit: 10 }))
      .rejects.toThrow(/unknown discord accountid/i);
    await adapter.stop();
  });

  it("fetchHistory: throws when channel has no messages API", async () => {
    const { client, adapter } = singleAccountAdapter();
    client.channels.fetch = vi.fn().mockResolvedValue({ /* no messages */ });
    await adapter.start({ gateway: makeGateway() });
    await expect(adapter.fetchHistory({ accountId: "acct1", channelId: "ch-1" }, { limit: 10 }))
      .rejects.toThrow(/does not expose history/);
    await adapter.stop();
  });
});
