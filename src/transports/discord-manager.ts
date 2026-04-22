// src/transports/discord-manager.ts — Manages multiple DiscordTransport instances
// Each Discord bot account gets its own transport (Client, token, identity).

import type {
  ChannelsConfig,
  DiscordAccountConfig,
  SessionStore,
} from "../core/types.js";
import type { DefaultAgentManager } from "../core/agent-manager.js";
import { getDiscordToken } from "../core/config.js";
import { DiscordTransport } from "./discord.js";
import { ThreadBindingManager } from "../core/thread-bindings.js";
import type { ReplyToMode } from "./reply-directive.js";
import type { UsageTracker } from "../core/usage-tracker.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("discord-manager");

const VALID_REPLY_TO_MODES = new Set<ReplyToMode>(["off", "first", "all"]);

/** Shared infrastructure injected into every Discord account transport. */
export interface DiscordSharedConfig {
  agentManager: DefaultAgentManager;
  sessionStore: SessionStore;
  sessionStoreForAgent?: (agentId: string) => SessionStore;
  /** Full channels block — passed through for per-guild lookups (e.g. requireMention). */
  channels?: ChannelsConfig;
  threadBindingManager?: ThreadBindingManager;
  usageTracker?: UsageTracker;
}

/** Configuration for the DiscordTransportManager */
export interface DiscordTransportManagerConfig {
  accounts: Record<string, DiscordAccountConfig>;
  shared: DiscordSharedConfig;
}

/**
 * DiscordTransportManager — creates and manages multiple DiscordTransport instances.
 *
 * Each account in the config gets its own transport with an independent Client,
 * token, and identity. All per-account behavior (dmAccess, allowBots, threadBindings,
 * subagentStreaming, context, adminUsers, etc.) is read from the account config.
 */
export class DiscordTransportManager {
  private transports: Map<string, DiscordTransport> = new Map();
  private config: DiscordTransportManagerConfig;

  constructor(config: DiscordTransportManagerConfig) {
    this.config = config;
  }

  /** Start all account transports. */
  async start(): Promise<void> {
    const entries = Object.entries(this.config.accounts);

    for (const [accountId, account] of entries) {
      if (account.replyToMode !== undefined && !VALID_REPLY_TO_MODES.has(account.replyToMode)) {
        throw new Error(
          `Invalid replyToMode "${account.replyToMode}" for Discord account "${accountId}" (must be off, first, or all)`,
        );
      }
      const token = getDiscordToken(account);
      const shared = this.config.shared;

      const transport = new DiscordTransport({
        token,
        agentManager: shared.agentManager,
        sessionStore: shared.sessionStore,
        sessionStoreForAgent: shared.sessionStoreForAgent,
        defaultAgentId: account.defaultAgentId,
        agentBindings: account.agentBindings,
        dmAccess: account.dmAccess,
        groupAccess: account.groupAccess,
        channels: shared.channels,
        accountId,
        threadBindings: account.threadBindings,
        threadBindingManager: shared.threadBindingManager,
        enableSubagentStreaming: account.subagentStreaming?.enabled,
        subagentShowToolCalls: account.subagentStreaming?.showToolCalls,
        allowBots: account.allowBots,
        context: account.context,
        usageTracker: shared.usageTracker,
        adminUsers: account.adminUsers,
        replyToMode: account.replyToMode,
      });

      this.transports.set(accountId, transport);
    }

    // Start all transports concurrently
    await Promise.all(
      [...this.transports.entries()].map(async ([accountId, transport]) => {
        await transport.start();
        log.info(`Discord account "${accountId}" started as ${transport.getClient().user?.tag ?? "(pending)"}`);
      }),
    );

    log.info(`Started ${this.transports.size} Discord account(s)`);
  }

  /** Stop all account transports. */
  async stop(): Promise<void> {
    await Promise.all(
      [...this.transports.values()].map((t) => t.stop()),
    );
    this.transports.clear();
  }

  /** Get a transport by account ID. */
  getTransport(accountId: string): DiscordTransport | undefined {
    return this.transports.get(accountId);
  }

  /** Get all running transports. */
  getAll(): Map<string, DiscordTransport> {
    return this.transports;
  }

  /** Number of managed transports. */
  get size(): number {
    return this.transports.size;
  }
}
