import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message as DiscordMessage,
  type SendableChannels,
} from "discord.js";
import type { Channel, ChannelActions, ChannelDeps } from "../types.js";
import type { Gateway } from "../../gateway/index.js";
import type { Logger } from "../../logging/logger.js";
import { loggers } from "../../logging/logger.js";
import { DedupeCache } from "./dedupe.js";
import { ChannelHistoryBuffer, formatHistory } from "./channel-history.js";
import { handleInbound, passesAllowlist, maybeHandleStop } from "./inbound.js";
import { createDiscordCallbacks } from "./outbound.js";
import { reactToMessage } from "./react.js";
import { resolveToken, mapGuildsForReceive } from "./config.js";
import { extractDiscordMetadata, formatInboundMeta } from "./message-metadata.js";
import { DiscordA2ASink, type DiscordA2ASinkDeps } from "./a2a-sink.js";
import { type A2ASinkFactory, runWithA2A } from "../../agent/a2a-sink.js";
import type {
  DiscordAccountConfig,
  DiscordChannelsConfig,
  GuildInboundConfig,
} from "./types.js";

const log = loggers.discord;


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

export function createDiscordChannel(
  rawConfig: unknown,
  options: CreateDiscordChannelOptions = {},
): Channel {
  const config = (rawConfig ?? {}) as DiscordChannelsConfig;
  const accounts = config.accounts ?? {};
  const clientFactory = options.clientFactory ?? defaultClientFactory;

  const clients = new Map<string, ClientLike>();
  const dedupes = new Map<string, DedupeCache>();
  const histories = new Map<string, ChannelHistoryBuffer>();
  // threadId → sub-run sessionId — populated by spawn_agent's A2A sink, used
  // to route /stop posted in a sub-run thread to the right cancel target.
  const a2aThreads = new Map<string, string>();

  return {
    async start(deps: ChannelDeps) {
      const { gateway, logger } = deps;
      const accountIds = Object.keys(accounts);
      if (accountIds.length === 0) {
        logger.warn("channels.discord present but no accounts configured — adapter is a no-op");
        return;
      }

      await Promise.all(
        Object.entries(accounts).map(([accountId, account]) =>
          startAccount({
            accountId,
            account,
            gateway,
            logger,
            clientFactory,
            clients,
            dedupes,
            histories,
            a2aThreads,
          }),
        ),
      );

      // Per-agent: bind each context to ONLY the bots that serve that agent
      // (defaultAgentId or agentBindings match). Honors agent↔bot identity for
      // tools like message_react that must act as the agent's bot.
      if (deps.channelContexts && clients.size > 0) {
        for (const [agentId, ctx] of deps.channelContexts.entries()) {
          const agentClients = clientsForAgent(agentId, accounts, clients);
          if (agentClients.length === 0) continue;
          const actions: ChannelActions = {
            react: (id, emoji, channelId) => reactToMessage(agentClients, id, emoji, channelId),
          };
          ctx.setChannelActions(actions);
        }
      }
    },

    async stop() {
      await Promise.all(
        Array.from(clients.values()).map(async (client) => {
          try {
            client.removeAllListeners?.();
            const result = client.destroy();
            if (result && typeof (result as Promise<void>).then === "function") await result;
          } catch (err) {
            log.warn(`discord: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }),
      );
      clients.clear();
      for (const dedupe of dedupes.values()) dedupe.clear();
      dedupes.clear();
      for (const h of histories.values()) h.clear();
      histories.clear();
    },
  };
}


interface StartAccountArgs {
  accountId: string;
  account: DiscordAccountConfig;
  gateway: Gateway;
  logger: Logger;
  clientFactory: ClientFactory;
  clients: Map<string, ClientLike>;
  dedupes: Map<string, DedupeCache>;
  histories: Map<string, ChannelHistoryBuffer>;
  a2aThreads: Map<string, string>;
}

async function startAccount(args: StartAccountArgs): Promise<void> {
  const { accountId, account, gateway, logger, clientFactory, clients, dedupes, histories, a2aThreads } = args;

  const token = resolveToken(account);
  if (!token) {
    logger.warn(`discord: account "${accountId}" has no token/tokenEnv — skipping`);
    return;
  }

  const client = clientFactory();
  clients.set(accountId, client);

  const dedupe = new DedupeCache();
  dedupes.set(accountId, dedupe);
  const history = new ChannelHistoryBuffer();
  histories.set(accountId, history);
  const guildsForReceive = mapGuildsForReceive(account.guilds);

  client.on("clientReady", () => {
    logger.info(`discord: account "${accountId}" logged in as ${client.user?.tag ?? client.user?.id ?? "?"}`);
  });

  client.on("error", (err: unknown) => {
    logger.error(`discord: client error (${accountId}): ${err instanceof Error ? err.message : String(err)}`);
  });

  client.on("messageCreate", (...rawArgs: unknown[]) => {
    const msg = rawArgs[0] as DiscordMessage;
    void dispatchInbound({
      msg,
      account,
      client,
      gateway,
      dedupe,
      history,
      guildsForReceive,
      a2aThreads,
    }).catch((err) => {
      logger.error(`discord: receive failed: ${err instanceof Error ? err.message : String(err)}`);
    });
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
  guildsForReceive: Record<string, GuildInboundConfig> | undefined;
  a2aThreads: Map<string, string>;
}

async function dispatchInbound(args: InboundArgs): Promise<void> {
  const { msg, account, client, gateway, dedupe, history, guildsForReceive, a2aThreads } = args;
  const botId = client.user?.id;
  if (!botId) return;

  if (!passesAllowlist(msg, account)) return;

  // Observe every allowlisted guild msg into the channel history buffer
  // (DMs are 1:1 — session memory is enough). Buffer is consumed (with
  // trigger excluded) and cleared by transformContent on engaged dispatch.
  if (msg.guild && msg.author.id !== botId) {
    history.append(msg.channelId, {
      messageId: msg.id,
      sender: msg.author.username,
      body: msg.content,
      timestamp: msg.createdTimestamp,
    });
  }

  const agentId = resolveAgentId(msg, account.agentBindings, account.defaultAgentId ?? "default");
  const sessionKey = resolveSessionKey(msg, botId);
  const stopped = await maybeHandleStop(msg, botId, gateway, agentId, sessionKey);
  if (stopped) return;

  const sinkFactory = buildSinkFactory(client, msg.channelId, a2aThreads);
  await runWithA2A(sinkFactory, () => handleInbound(
    msg,
    { agentId, sessionKey },
    {
      gateway,
      dedupe,
      ...(guildsForReceive ? { guilds: guildsForReceive } : {}),
      ...(account.allowBots ? { allowBots: account.allowBots } : {}),
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
      buildCallbacks: (triggerMsg) =>
        createDiscordCallbacks({
          channel: triggerMsg.channel as SendableChannels,
          triggerMessageId: triggerMsg.id,
        }),
    },
  ));
}


/** Find every account whose defaultAgentId or agentBindings serves this agent. */
function clientsForAgent(
  agentId: string,
  accounts: Record<string, DiscordAccountConfig>,
  clients: Map<string, ClientLike>,
): ClientLike[] {
  const matched: ClientLike[] = [];
  for (const [accountId, account] of Object.entries(accounts)) {
    const bindingMatch = account.agentBindings
      && Object.values(account.agentBindings).includes(agentId);
    if (account.defaultAgentId === agentId || bindingMatch) {
      const client = clients.get(accountId);
      if (client) matched.push(client);
    }
  }
  return matched;
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

function resolveAgentId(
  msg: DiscordMessage,
  agentBindings: Record<string, string> | undefined,
  defaultAgentId: string,
): string {
  if (agentBindings) {
    for (const [botUserId, agentId] of Object.entries(agentBindings)) {
      if (msg.mentions?.has?.(botUserId)) return agentId;
    }
  }
  return defaultAgentId;
}

function resolveSessionKey(msg: DiscordMessage, botId: string): string {
  // msg.channel.isThread() is the correct check — msg.thread means "this msg
  // *spawned* a thread", not "this msg *is in* one".
  const ch = msg.channel as { isThread?: () => boolean };
  if (ch?.isThread?.()) return `discord:${botId}:thread:${msg.channelId}`;
  if (!msg.guild) return `discord:${botId}:dm:${msg.author.id}`;
  return `discord:${botId}:channel:${msg.channelId}`;
}
