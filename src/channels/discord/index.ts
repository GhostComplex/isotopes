import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message as DiscordMessage,
  type SendableChannels,
} from "discord.js";
import type { Channel, ChannelActions, ChannelDeps } from "../types.js";
import type { Gateway } from "../../gateway/index.js";

import { DedupeCache } from "./dedupe.js";
import { ChannelHistoryBuffer, formatHistory, type HistoryEntry } from "./channel-history.js";
import { handleInbound, passesAllowlist, handleStopCommand } from "./inbound.js";
import { createDiscordSubscriber } from "./outbound.js";
import { react } from "./react.js";
import { resolveToken } from "./config.js";
import { extractDiscordMetadata, formatInboundMeta } from "./message-metadata.js";
import { DiscordA2ASink, type DiscordA2ASinkDeps } from "./a2a-sink.js";
import { type A2ASinkFactory, runWithA2A } from "../../agent/a2a-sink.js";
import type {
  DiscordAccountConfig,
  DiscordChannelsConfig,
} from "./types.js";

/** Minimum surface the adapter touches — testable without discord.js. */
export interface ClientLike {
  user: { id: string; tag?: string } | null;
  channels: { fetch: (id: string) => Promise<unknown>; cache: Map<string, unknown> };
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  removeAllListeners?(): unknown;
  login(token: string): Promise<unknown>;
  destroy(): unknown;
}

/** Test seam: inject a mock Client without depending on discord.js. */
type ClientFactory = () => ClientLike;

const defaultClientFactory: ClientFactory = () =>
  new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember],
  }) as unknown as ClientLike;

interface CreateDiscordChannelOptions {
  /** Test seam: override Discord.js Client construction. */
  clientFactory?: ClientFactory;
}

/** Address for outbound send / history fetch. */
export interface DiscordTarget {
  accountId: string;
  channelId: string;
  threadId?: string;
}

/** Discord channel exposes the standard Channel lifecycle plus direct outbound. */
export interface DiscordChannel extends Channel {
  send(target: DiscordTarget, content: string): Promise<{ id: string }>;
  fetchHistory(target: DiscordTarget, opts: { limit: number }): Promise<HistoryEntry[]>;
}

export function createDiscordChannel(
  rawConfig: unknown,
  options: CreateDiscordChannelOptions = {},
): DiscordChannel {
  const config = (rawConfig ?? {}) as DiscordChannelsConfig;
  const accounts = config.accounts ?? {};
  const clientFactory = options.clientFactory ?? defaultClientFactory;

  const clients = new Map<string, ClientLike>();
  const dedupes = new Map<string, DedupeCache>();
  const histories = new Map<string, ChannelHistoryBuffer>();
  // threadId → sub-run sessionId — populated by spawn_agent's A2A sink, used
  // to route /stop posted in a sub-run thread to the right cancel target.
  const a2aThreads = new Map<string, string>();

  function resolveClient(accountId: string): ClientLike {
    const client = clients.get(accountId);
    if (!client) throw new Error(`Unknown Discord accountId "${accountId}"`);
    return client;
  }

  return {
    async start(deps: ChannelDeps) {
      const { gateway } = deps;
      const accountIds = Object.keys(accounts);
      if (accountIds.length === 0) {
        return;
      }

      await Promise.all(
        Object.entries(accounts).map(([accountId, account]) =>
          startAccount({
            accountId,
            account,
            gateway,
            clientFactory,
            clients,
            dedupes,
            histories,
            a2aThreads,
          }),
        ),
      );

      if (deps.channelContexts && clients.size > 0) {
        for (const [agentId, ctx] of deps.channelContexts.entries()) {
          const actions: ChannelActions = {
            react: (messageId, emoji, channelId) => {
              const client = clientForAgentInChannel(agentId, channelId, accounts, clients);
              if (!client) throw new Error(`No bot serves agent "${agentId}" in channel ${channelId}`);
              return react(client, messageId, emoji, channelId);
            },
          };
          ctx.setChannelActions(actions);
        }
      }
    },

    async stop() {
      await Promise.all(
        Array.from(clients.values()).map(async (client) => {
          client.removeAllListeners?.();
          const result = client.destroy();
          if (result && typeof (result as Promise<void>).then === "function") await result;
        }),
      );
      clients.clear();
      for (const dedupe of dedupes.values()) dedupe.clear();
      dedupes.clear();
      for (const h of histories.values()) h.clear();
      histories.clear();
    },

    async send(target, content) {
      const client = resolveClient(target.accountId);
      const destId = target.threadId ?? target.channelId;
      const ch = (await client.channels.fetch(destId)) as
        | { send?: (c: string) => Promise<{ id: string }> }
        | null;
      if (!ch?.send) throw new Error(`Discord channel ${destId} is not sendable`);
      const sent = await ch.send(content);
      return { id: sent.id };
    },

    async fetchHistory(target, { limit }) {
      const client = resolveClient(target.accountId);
      const sourceId = target.threadId ?? target.channelId;
      const ch = (await client.channels.fetch(sourceId)) as
        | {
            messages?: {
              fetch: (opts: { limit: number }) => Promise<Map<string, DiscordMessage> | Iterable<[string, DiscordMessage]>>;
            };
          }
        | null;
      if (!ch?.messages?.fetch) throw new Error(`Discord channel ${sourceId} does not expose history`);
      const clamped = Math.min(Math.max(Math.floor(limit), 1), 100);
      const fetched = await ch.messages.fetch({ limit: clamped });
      const entries: HistoryEntry[] = [];
      for (const [, m] of fetched as Iterable<[string, DiscordMessage]>) {
        entries.push({
          messageId: m.id,
          sender: m.author?.username ?? "unknown",
          body: m.content ?? "",
          timestamp: m.createdTimestamp ?? 0,
        });
      }
      // Discord returns newest-first; reverse for natural reading order.
      entries.reverse();
      return entries;
    },
  };
}

interface StartAccountArgs {
  accountId: string;
  account: DiscordAccountConfig;
  gateway: Gateway;
  clientFactory: ClientFactory;
  clients: Map<string, ClientLike>;
  dedupes: Map<string, DedupeCache>;
  histories: Map<string, ChannelHistoryBuffer>;
  a2aThreads: Map<string, string>;
}

async function startAccount(args: StartAccountArgs): Promise<void> {
  const { accountId, account, gateway, clientFactory, clients, dedupes, histories, a2aThreads } = args;

  const token = resolveToken(account);
  if (!token) {
    return;
  }

  const client = clientFactory();
  clients.set(accountId, client);

  const dedupe = new DedupeCache();
  dedupes.set(accountId, dedupe);
  const history = new ChannelHistoryBuffer();
  histories.set(accountId, history);

  client.on("error", () => {});

  client.on("messageCreate", (...rawArgs: unknown[]) => {
    const msg = rawArgs[0] as DiscordMessage;
    void dispatchInbound({
      msg,
      account,
      client,
      gateway,
      dedupe,
      history,
      a2aThreads,
    });
  });

  // discord.js v14 doesn't reliably emit messageCreate for DMs even with
  // Partials.Channel. Intercept raw gateway packets and manually fetch the
  // Message for DM MESSAGE_CREATE events. Dedupe in dispatchInbound prevents
  // double-dispatch if discord.js eventually fires messageCreate too.
  client.on("raw", (...rawArgs: unknown[]) => {
    const packet = rawArgs[0] as { t?: string; d?: unknown } | undefined;
    if (!packet || packet.t !== "MESSAGE_CREATE") return;
    const data = (packet.d ?? {}) as Record<string, unknown>;
    if (data.guild_id) return; // only DMs
    const channelId = data.channel_id as string | undefined;
    const messageId = data.id as string | undefined;
    if (!channelId || !messageId) return;
    void (async () => {
      try {
        const channels = (client as unknown as {
          channels?: { fetch?: (id: string) => Promise<unknown> };
        }).channels;
        const channel = (await channels?.fetch?.(channelId)) as
          | { isTextBased?: () => boolean; messages?: { fetch: (id: string) => Promise<DiscordMessage> } }
          | null
          | undefined;
        if (!channel || (channel.isTextBased && !channel.isTextBased())) return;
        const fetched = await channel.messages?.fetch(messageId);
        if (!fetched) return;
        await dispatchInbound({
          msg: fetched,
          account,
          client,
          gateway,
          dedupe,
          history,
          a2aThreads,
        });
      } catch { /* ignore */ }
    })();
  });

  await client.login(token);
}

interface InboundArgs {
  msg: DiscordMessage;
  account: DiscordAccountConfig;
  client: ClientLike;
  gateway: Gateway;
  dedupe: DedupeCache;
  history: ChannelHistoryBuffer;
  a2aThreads: Map<string, string>;
}

async function dispatchInbound(args: InboundArgs): Promise<void> {
  const { msg, account, client, gateway, dedupe, history, a2aThreads } = args;
  const botId = client.user?.id;
  if (!botId) return;

  if (!passesAllowlist(msg, account)) return;

  // Dedupe: WS RESUME may replay messages. Drop duplicates before any side
  // effects (history append, /stop intercept, dispatch).
  if (dedupe.isDuplicate(msg.id)) {
    return;
  }

  const agentId = resolveAgentId(msg, account);
  const sessionKey = resolveSessionKey(msg, botId);

  // /stop runs before history.append so the command never leaks into channel
  // history (or any LLM session). Every bot consumes /stop; only the
  // addressed bot actually aborts.
  const isStopCommand = await handleStopCommand(msg, botId, gateway, agentId, sessionKey, a2aThreads);
  if (isStopCommand) return;

  if (msg.guild && msg.author.id !== botId) {
    history.append(msg.channelId, {
      messageId: msg.id,
      sender: msg.author.username,
      body: msg.content,
      timestamp: msg.createdTimestamp,
    });
  }

  const sinkFactory = buildSinkFactory(client, msg.channelId, a2aThreads);
  await runWithA2A(sinkFactory, () => handleInbound(
    msg,
    { agentId, sessionKey },
    {
      gateway,
      ...(account.guilds ? { guilds: account.guilds } : {}),
      ...(account.allowBots !== undefined ? { allowBots: account.allowBots } : {}),
      transformContent: (content, triggerMsg) => {
        const meta = extractDiscordMetadata(triggerMsg);
        const chatType = triggerMsg.guild ? "group" : "direct";
        const historyBlock = triggerMsg.guild
          ? formatHistory(history.consumeExcluding(triggerMsg.channelId, triggerMsg.id))
          : "";
        const prefix = historyBlock ? `${historyBlock}\n\n${formatInboundMeta(meta, chatType)}` : formatInboundMeta(meta, chatType);
        return `${prefix}\n\n${content}`;
      },
    },
    {
      botId,
      buildSubscriber: (triggerMsg) =>
        createDiscordSubscriber({
          channel: triggerMsg.channel as SendableChannels,
          triggerMessageId: triggerMsg.id,
        }),
    },
  ));
}

/** Find the unique account whose effective agent for this channel matches. */
function clientForAgentInChannel(
  agentId: string,
  channelId: string,
  accounts: Record<string, DiscordAccountConfig>,
  clients: Map<string, ClientLike>,
): ClientLike | undefined {
  for (const [accountId, account] of Object.entries(accounts)) {
    const effectiveAgent = account.perChannelAgent?.[channelId] ?? account.defaultAgentId;
    if (effectiveAgent === agentId) return clients.get(accountId);
  }
  return undefined;
}

function buildSinkFactory(
  client: ClientLike,
  parentChannelId: string,
  a2aThreads: Map<string, string>,
): A2ASinkFactory {
  const deps: DiscordA2ASinkDeps = {
    parentChannelId,
    showToolCalls: true,
    sendMessage: async (channelId, content) => {
      const ch = (await client.channels.fetch(channelId)) as
        | { send?: (c: string) => Promise<{ id: string }> }
        | null;
      if (!ch?.send) throw new Error(`Channel ${channelId} not sendable`);
      const sent = await ch.send(content);
      return { id: sent.id };
    },
    createThread: async (parentId, name, messageId) => {
      const ch = (await client.channels.fetch(parentId)) as
        | { threads?: { create: (opts: { name: string; startMessage: string; autoArchiveDuration: number }) => Promise<{ id: string }> } }
        | null;
      if (!ch?.threads) throw new Error(`Channel ${parentId} does not support threads`);
      const thread = await ch.threads.create({ name, startMessage: messageId, autoArchiveDuration: 60 });
      return { id: thread.id };
    },
    registerA2AThread: (threadId, sessionId) => { a2aThreads.set(threadId, sessionId); },
    unregisterA2AThread: (threadId) => { a2aThreads.delete(threadId); },
  };
  return () => new DiscordA2ASink(deps);
}

function resolveSessionKey(msg: DiscordMessage, botId: string): string {
  // msg.channel.isThread() is the correct check — msg.thread means "this msg
  // *spawned* a thread", not "this msg *is in* one".
  const ch = msg.channel as { isThread?: () => boolean };
  if (ch?.isThread?.()) return `discord:${botId}:thread:${msg.channelId}`;
  if (!msg.guild) return `discord:${botId}:dm:${msg.author.id}`;
  return `discord:${botId}:channel:${msg.channelId}`;
}

function resolveAgentId(msg: DiscordMessage, account: DiscordAccountConfig): string {
  // Threads inherit their parent channel's perChannelAgent mapping.
  const ch = msg.channel as { isThread?: () => boolean; parentId?: string | null };
  const lookupChannelId = ch.isThread?.() && ch.parentId ? ch.parentId : msg.channelId;
  return account.perChannelAgent?.[lookupChannelId] ?? account.defaultAgentId;
}
