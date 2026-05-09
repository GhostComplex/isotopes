import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message as DiscordMessage,
  type SendableChannels,
  type ThreadChannel,
} from "discord.js";
import path from "node:path";
import type { ChannelAdapter, ChannelAdapterDeps } from "../types.js";
import type { Gateway } from "../../gateway/index.js";
import type { Logger } from "../../logging/logger.js";
import type { Channel } from "../../channels/types.js";
import { loggers } from "../../logging/logger.js";
import { getIsotopesHome } from "../../paths.js";
import { DedupeCache } from "./dedupe.js";
import { receiveDiscordMessage, resolveAgentId, resolveSessionKey, type GuildReceiveConfig } from "./receive.js";
import { createDiscordCallbacks } from "./outbound.js";
import { extractDiscordMetadata, formatInboundMeta } from "./message-metadata.js";
import { ThreadBindingManager } from "./thread-binding.js";
import type {
  DiscordAccountConfig,
  DiscordChannelsConfig,
  GuildConfig,
} from "./types.js";

const log = loggers.discord;


/** Minimal Discord client surface the adapter actually uses. */
export interface ClientLike {
  user: { id: string; tag?: string } | null;
  channels: { fetch: (id: string) => Promise<unknown>; cache: Map<string, unknown> };
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  removeAllListeners?(): unknown;
  login(token: string): Promise<unknown>;
  destroy(): unknown;
}

/** Factory so tests can inject a mock Client without touching discord.js. */
export type ClientFactory = () => ClientLike;

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


interface ResolvedGroupPolicy {
  policy: "disabled" | "allowlist" | "open";
  channelAllowlist?: string[];
  guildAllowlist?: string[];
}

function resolveGroupPolicy(account: DiscordAccountConfig): ResolvedGroupPolicy {
  const g = account.groupAccess;
  if (g?.policy || g?.channelAllowlist?.length || g?.guildAllowlist?.length) {
    return {
      policy: g.policy ?? "allowlist",
      channelAllowlist: g.channelAllowlist,
      guildAllowlist: g.guildAllowlist,
    };
  }
  return { policy: "allowlist" };
}

function isDmAllowed(account: DiscordAccountConfig, userId: string): boolean {
  const dm = account.dmAccess;
  if (dm?.policy) {
    switch (dm.policy) {
      case "disabled":
        return false;
      case "allowlist":
        return dm.allowlist?.includes(userId) ?? false;
    }
  }
  return false;
}

/**
 * Pre-receive policy gate. Returns true when the message is allowed to flow
 * into the inbound pipeline; false silently drops it.
 */
function passesAllowlist(msg: DiscordMessage, account: DiscordAccountConfig): boolean {
  if (!msg.guild) {
    const ok = isDmAllowed(account, msg.author.id);
    if (!ok) log.debug(`discord: drop dm from ${msg.author.id} (dmAccess policy)`);
    return ok;
  }
  const group = resolveGroupPolicy(account);
  if (group.policy === "disabled") {
    log.debug(`discord: drop guild message ${msg.id} (groupAccess.policy=disabled)`);
    return false;
  }
  if (group.policy === "allowlist") {
    const channelOk = group.channelAllowlist?.includes(msg.channelId) ?? false;
    const guildOk = group.guildAllowlist?.includes(msg.guild.id) ?? false;
    if (!channelOk && !guildOk) {
      log.debug(
        `discord: drop guild message ${msg.id} (not in groupAccess allowlist, ` +
          `guild=${msg.guild.id} channel=${msg.channelId})`,
      );
      return false;
    }
  }
  return true;
}


const STOP_CMD_RE = /^(?:<@!?\S+>\s*)?\/(stop|cancel)\s*$/i;

/**
 * If the message is a /stop or /cancel directed at this bot, abort the
 * current run for the resolved sessionKey and return true. Returns false
 * when the message is not a stop command.
 */
async function maybeHandleStop(
  msg: DiscordMessage,
  botId: string,
  gateway: Gateway,
  agentId: string,
  sessionKey: string,
): Promise<boolean> {
  if (!STOP_CMD_RE.test(msg.content.trim())) return false;
  // In guild channels we still require the @mention so a shared /stop in a
  // multi-bot channel only aborts the addressed bot's session. DMs are 1:1.
  if (msg.guild && !msg.mentions?.has?.(botId)) return true; // not for us, but consume
  let cancelled = false;
  try {
    cancelled = await gateway.abortByKey(agentId, sessionKey, "user");
    log.info(`discord: /stop ${cancelled ? "aborted" : "no active run"} for sessionKey=${sessionKey}`);
  } catch (err) {
    log.warn(`discord: /stop abort failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if ("send" in msg.channel) {
    try {
      await (msg.channel as SendableChannels).send(cancelled ? "🛑 Stopped." : "(nothing to stop)");
    } catch {
      /* ignore */
    }
  }
  return true;
}


export interface CreateDiscordChannelOptions {
  /** Test seam: override Discord.js Client construction. */
  clientFactory?: ClientFactory;
  /** Test seam: override ThreadBindingManager. */
  threadBindingManager?: ThreadBindingManager;
}

/**
 * Build a Discord ChannelAdapter from a `channels.discord` config block.
 * The returned adapter is started by the channel loader.
 */
export function createDiscordChannel(
  rawConfig: unknown,
  options: CreateDiscordChannelOptions = {},
): ChannelAdapter {
  const config = (rawConfig ?? {}) as DiscordChannelsConfig;
  const accounts = config.accounts ?? {};
  const clientFactory = options.clientFactory ?? defaultClientFactory;

  const clients = new Map<string, ClientLike>();
  const dedupes = new Map<string, DedupeCache>();
  let threadBindings: ThreadBindingManager | null = options.threadBindingManager ?? null;

  return {
    async start(deps: ChannelAdapterDeps) {
      const { gateway, logger } = deps;
      const accountIds = Object.keys(accounts);
      if (accountIds.length === 0) {
        logger.warn("channels.discord present but no accounts configured — adapter is a no-op");
        return;
      }

      // Lazily initialize the thread-binding manager (shared across accounts).
      if (!threadBindings) {
        const persistPath = path.join(getIsotopesHome(), "thread-bindings.json");
        threadBindings = new ThreadBindingManager({ persistPath });
        await threadBindings.load({ clearStale: true });
        if (threadBindings.size > 0) {
          logger.info(`Loaded ${threadBindings.size} persisted thread binding(s)`);
        }
      }

      const tb = threadBindings;
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
            threadBindings: tb,
          }),
        ),
      );

      // Bind react capability into per-agent channel contexts so the
      // `message_react` agent tool can call back into Discord.
      if (deps.channelContexts && clients.size > 0) {
        const channel: Channel = {
          react: (id, emoji, channelId) => reactToMessage(clients, id, emoji, channelId),
        };
        for (const ctx of deps.channelContexts.values()) ctx.setChannel(channel);
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
  threadBindings: ThreadBindingManager;
}

async function startAccount(args: StartAccountArgs): Promise<void> {
  const { accountId, account, gateway, logger, clientFactory, clients, dedupes, threadBindings } = args;

  const token = resolveToken(account);
  if (!token) {
    logger.warn(`discord: account "${accountId}" has no token/tokenEnv — skipping`);
    return;
  }

  const client = clientFactory();
  clients.set(accountId, client);

  const dedupe = new DedupeCache();
  dedupes.set(accountId, dedupe);
  const guildsForReceive = mapGuildsForReceive(account.guilds);

  client.on("clientReady", () => {
    logger.info(`discord: account "${accountId}" logged in as ${client.user?.tag ?? client.user?.id ?? "?"}`);
  });

  client.on("error", (err: unknown) => {
    logger.error(`discord: client error (${accountId}): ${err instanceof Error ? err.message : String(err)}`);
  });

  client.on("messageCreate", (...rawArgs: unknown[]) => {
    const msg = rawArgs[0] as DiscordMessage;
    void handleInbound({
      msg,
      account,
      client,
      gateway,
      dedupe,
      guildsForReceive,
    }).catch((err) => {
      logger.error(`discord: receive failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  // discord.js v14 doesn't reliably emit messageCreate for DMs even with
  // Partials.Channel. Intercept raw gateway packets and manually fetch the
  // Message object for DM MESSAGE_CREATE events.
  client.on("raw", (...rawArgs: unknown[]) => {
    const packet = rawArgs[0] as { t?: string; d?: unknown } | undefined;
    if (!packet || packet.t !== "MESSAGE_CREATE") return;
    const data = (packet.d ?? {}) as Record<string, unknown>;
    if (data.guild_id) return; // only DMs

    const channelId = data.channel_id as string | undefined;
    const messageId = data.id as string | undefined;
    if (!channelId || !messageId) return;

    const botId = client.user?.id;
    if (!botId) return;
    // Cheap pre-gate: if messageCreate already processed this DM, skip the
    // two HTTP fetches below. Real dedupe happens inside receive.ts.
    if (dedupe.peek(`${botId}:${channelId}:${messageId}`)) return;

    void (async () => {
      try {
        const channel = (await client.channels.fetch(channelId)) as
          | { isTextBased?: () => boolean; messages?: { fetch: (id: string) => Promise<DiscordMessage> } }
          | null
          | undefined;
        if (!channel || (channel.isTextBased && !channel.isTextBased())) return;
        const fetched = await channel.messages?.fetch(messageId);
        if (!fetched) return;
        await handleInbound({
          msg: fetched,
          account,
          client,
          gateway,
          dedupe,
          guildsForReceive,
        });
      } catch (err) {
        logger.warn(
          `discord: raw DM fetch failed for channel=${channelId} message=${messageId}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  });

  if (account.threadBindings?.enabled) {
    client.on("threadCreate", (...rawArgs: unknown[]) => {
      const thread = rawArgs[0] as ThreadChannel;
      try {
        autoBindThread(thread, account, threadBindings, logger);
      } catch (err) {
        logger.warn(`discord: threadCreate handler failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  await client.login(token);
}

interface InboundArgs {
  msg: DiscordMessage;
  account: DiscordAccountConfig;
  client: ClientLike;
  gateway: Gateway;
  dedupe: DedupeCache;
  guildsForReceive: Record<string, GuildReceiveConfig> | undefined;
}

async function handleInbound(args: InboundArgs): Promise<void> {
  const { msg, account, client, gateway, dedupe, guildsForReceive } = args;
  const botId = client.user?.id;
  if (!botId) return;

  if (!passesAllowlist(msg, account)) return;

  const agentId = resolveAgentId(msg, account.agentBindings, account.defaultAgentId ?? "default");
  const sessionKey = resolveSessionKey(msg, botId);
  const stopped = await maybeHandleStop(msg, botId, gateway, agentId, sessionKey);
  if (stopped) return;

  await receiveDiscordMessage(
    msg,
    {
      gateway,
      ...(account.agentBindings ? { agentBindings: account.agentBindings } : {}),
      ...(account.defaultAgentId ? { defaultAgentId: account.defaultAgentId } : {}),
      dedupe,
      ...(guildsForReceive ? { guilds: guildsForReceive } : {}),
      ...(account.context?.dedupe === false ? { dedupeEnabled: false } : {}),
      ...(account.allowBots ? { allowBots: account.allowBots } : {}),
      transformContent: (content, triggerMsg) => {
        const meta = extractDiscordMetadata(triggerMsg);
        const chatType = triggerMsg.guild ? "group" : "direct";
        return `${formatInboundMeta(meta, chatType)}\n\n${content}`;
      },
    },
    {
      botId,
      buildCallbacks: (triggerMsg) =>
        createDiscordCallbacks({
          channel: triggerMsg.channel as SendableChannels,
          triggerMessage: triggerMsg,
        }),
    },
  );
}


function resolveToken(account: DiscordAccountConfig): string | null {
  if (account.token) return account.token;
  if (account.tokenEnv) return process.env[account.tokenEnv] ?? null;
  return null;
}

function mapGuildsForReceive(
  guilds: Record<string, GuildConfig> | undefined,
): Record<string, GuildReceiveConfig> | undefined {
  if (!guilds) return undefined;
  const out: Record<string, GuildReceiveConfig> = {};
  for (const [id, g] of Object.entries(guilds)) {
    if (g.requireMention !== undefined) out[id] = { requireMention: g.requireMention };
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * autoBindThread is called from the threadCreate handler — its parent channel
 * gates entirely on group-policy allowlist. agentId falls back to "default"
 * when no defaultAgentId is configured.
 */
function autoBindThread(
  thread: ThreadChannel,
  account: DiscordAccountConfig,
  threadBindings: ThreadBindingManager,
  logger: Logger,
): void {
  if (!thread.parentId) {
    logger.debug(`discord: ignoring thread ${thread.id} — no parent channel`);
    return;
  }
  const group = resolveGroupPolicy(account);
  if (group.policy === "disabled") return;
  if (group.policy === "allowlist") {
    const channelOk = group.channelAllowlist?.includes(thread.parentId) ?? false;
    const guildOk = group.guildAllowlist?.includes(thread.guildId) ?? false;
    if (!channelOk && !guildOk) {
      logger.debug(`discord: ignoring thread ${thread.id} — parent not in allowlist`);
      return;
    }
  }
  const agentId = account.defaultAgentId ?? "default";
  logger.info(`discord: thread ${thread.id} created in ${thread.parentId}, binding to agent ${agentId}`);
  threadBindings.bind(thread.id, { parentChannelId: thread.parentId, agentId });
}

/**
 * Add an emoji reaction to a message. Tries channelId fast-path first, then
 * falls back to scanning every cached channel across all bots. Used by the
 * `message_react` agent tool via the LazyChannelContext binding.
 */
async function reactToMessage(
  clients: Map<string, ClientLike>,
  messageId: string,
  emoji: string,
  channelId?: string,
): Promise<void> {
  for (const client of clients.values()) {
    if (channelId) {
      try {
        const channel = (await client.channels.fetch(channelId)) as
          | { messages?: { fetch: (id: string) => Promise<{ react: (e: string) => Promise<unknown> }> } }
          | null;
        const target = await channel?.messages?.fetch(messageId);
        if (target) {
          await target.react(emoji);
          return;
        }
      } catch { /* try slow path */ }
    }

    for (const ch of client.channels.cache.values()) {
      const messages = (ch as { messages?: { fetch: (id: string) => Promise<{ react: (e: string) => Promise<unknown> }> } }).messages;
      if (!messages) continue;
      try {
        const target = await messages.fetch(messageId);
        if (target) {
          await target.react(emoji);
          return;
        }
      } catch { /* not in this channel */ }
    }
  }
  throw new Error(`Message not found: ${messageId}`);
}
