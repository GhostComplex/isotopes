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
import { handleInbound, passesAllowlist, handleStopCommand } from "./inbound.js";
import { createDiscordCallbacks } from "./outbound.js";
import { react } from "./react.js";
import { resolveToken } from "./config.js";
import { extractDiscordMetadata, formatInboundMeta } from "./message-metadata.js";
import { DiscordA2ASink, type DiscordA2ASinkDeps } from "./a2a-sink.js";
import { type A2ASinkFactory, runWithA2A } from "../../agent/a2a-sink.js";
import type {
  DiscordAccountConfig,
  DiscordChannelsConfig,
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

      // Per-agent: bind a Channel actions object that resolves (agent, channel)
      // → bot at call time. Errors clearly when no bot serves the agent in the
      // requested channel.
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
    log.debug(`discord receive: dedupe drop ${msg.id}`);
    return;
  }

  const agentId = resolveAgentId(msg, account);
  const sessionKey = resolveSessionKey(msg, botId);

  // /stop runs before history.append so the command never leaks into channel
  // history (or any LLM session). Every bot consumes /stop; only the
  // addressed bot actually aborts.
  const isStopCommand = await handleStopCommand(msg, botId, gateway, agentId, sessionKey, a2aThreads);
  if (isStopCommand) return;

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

  const sinkFactory = buildSinkFactory(client, msg.channelId, a2aThreads);
  await runWithA2A(sinkFactory, () => handleInbound(
    msg,
    { agentId, sessionKey },
    {
      gateway,
      ...(account.guilds ? { guilds: account.guilds } : {}),
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
