// src/channels/discord/index.ts — Discord ChannelAdapter.
//
// This is the integrating module for the Discord channel: it owns the
// Discord.js Client lifecycle (one per account), wires inbound messages
// through the receive pipeline (./receive.ts) into the gateway, and builds
// per-message outbound callbacks (./outbound.ts) that stream agent text
// back to the channel.
//
// Scope kept intentionally narrow per the migration plan:
//  - allowlist policy (DM + group) lifted from legacy (fail-closed)
//  - /stop and /cancel routed through gateway.abort
//  - ThreadBindingManager instantiated per adapter, threadCreate auto-binds
//
// NOT yet wired here (deferred until S5/app.ts rewires the larger surface):
//  - channel history buffer / inbound metadata enrichment
//  - inbound debouncer
//  - image attachment extraction
//  - slash commands beyond /stop|/cancel (admin commands stay legacy for now)
//  - the spawn_agent → thread streaming bridge (a2a-sink); this is wired
//    elsewhere (spawn-agent.ts, S1) and doesn't need adapter glue here.

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
import { loggers } from "../../logging/logger.js";
import { getIsotopesHome } from "../../paths.js";
import { DedupeCache } from "./dedupe.js";
import { receiveDiscordMessage, type GuildReceiveConfig } from "./receive.js";
import { createDiscordCallbacks } from "./outbound.js";
import { ThreadBindingManager } from "./thread-binding.js";
import type {
  DiscordAccountConfig,
  DiscordChannelsConfig,
  GuildConfig,
} from "./types.js";

const log = loggers.discord;

// ---------------------------------------------------------------------------
// Client factory (small wrapper to make the adapter testable)
// ---------------------------------------------------------------------------

/** Minimal Discord client surface the adapter actually uses. */
export interface ClientLike {
  user: { id: string; tag?: string } | null;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
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

// ---------------------------------------------------------------------------
// Allowlist policy (lifted from legacy/discord/discord.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// /stop interception
// ---------------------------------------------------------------------------

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
  buildSessionId: (msg: DiscordMessage) => string,
): Promise<boolean> {
  if (!STOP_CMD_RE.test(msg.content.trim())) return false;
  // In guild channels we still require the @mention so a shared /stop in a
  // multi-bot channel only aborts the addressed bot's session. DMs are 1:1.
  if (msg.guild && !msg.mentions?.has?.(botId)) return true; // not for us, but consume
  const sessionId = buildSessionId(msg);
  try {
    await gateway.abort(sessionId, "user");
    log.info(`discord: /stop sent abort for sessionId=${sessionId}`);
  } catch (err) {
    log.warn(`discord: /stop abort failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if ("send" in msg.channel) {
    try {
      await (msg.channel as SendableChannels).send("🛑 Stopped.");
    } catch {
      /* ignore */
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

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

  // One client per account; populated in start()
  const clients = new Map<string, ClientLike>();
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

      for (const [accountId, account] of Object.entries(accounts)) {
        await startAccount({
          accountId,
          account,
          gateway,
          logger,
          clientFactory,
          clients,
          threadBindings,
        });
      }
    },

    async stop() {
      for (const [, client] of clients) {
        try {
          client.destroy();
        } catch (err) {
          log.warn(`discord: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      clients.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Per-account wiring
// ---------------------------------------------------------------------------

interface StartAccountArgs {
  accountId: string;
  account: DiscordAccountConfig;
  gateway: Gateway;
  logger: Logger;
  clientFactory: ClientFactory;
  clients: Map<string, ClientLike>;
  threadBindings: ThreadBindingManager;
}

async function startAccount(args: StartAccountArgs): Promise<void> {
  const { accountId, account, gateway, logger, clientFactory, clients, threadBindings } = args;

  const token = resolveToken(account);
  if (!token) {
    logger.warn(`discord: account "${accountId}" has no token/tokenEnv — skipping`);
    return;
  }

  const client = clientFactory();
  clients.set(accountId, client);

  const dedupe = new DedupeCache();
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

  // Fail-closed allowlist gate before anything else.
  if (!passesAllowlist(msg, account)) return;

  // /stop handling — needs the same sessionKey logic the receive pipeline uses.
  const stopped = await maybeHandleStop(msg, botId, gateway, (m) =>
    buildSessionIdForStop(m, botId),
  );
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Build the sessionId used by `gateway.abort` for /stop.
 *
 * IMPORTANT: This is the *sessionKey* (e.g. `discord:bot:channel:123`), not
 * an underlying session UUID. The current Gateway abort contract takes a
 * session identifier; until the resolveSessionId step is fully internalized,
 * we pass the sessionKey and rely on the gateway/runtime to map it. The
 * legacy code resolved the UUID itself; in this refactor we lean on the
 * gateway abstraction.
 */
function buildSessionIdForStop(msg: DiscordMessage, botId: string): string {
  // Mirror resolveSessionKey from receive.ts (kept private there).
  if (msg.thread) return `discord:${botId}:thread:${msg.thread.id}`;
  if (!msg.guild) return `discord:${botId}:dm:${msg.author.id}`;
  return `discord:${botId}:channel:${msg.channelId}`;
}

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
