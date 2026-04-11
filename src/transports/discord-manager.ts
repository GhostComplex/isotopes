// src/transports/discord-manager.ts — Manages multiple DiscordTransport instances
// Each Discord bot account gets its own transport (Client, token, identity).

import type {
  AgentManager,
  ChannelsConfig,
  SessionStore,
  ThreadBindingConfig,
} from "../core/types.js";
import type { ContextConfigFile, DiscordAccountConfigFile } from "../core/config.js";
import { getDiscordToken } from "../core/config.js";
import { DiscordTransport } from "./discord.js";
import { ThreadBindingManager } from "../core/thread-bindings.js";
import type { UsageTracker } from "../core/usage-tracker.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("discord-manager");

/** Shared settings inherited by all Discord accounts */
export interface DiscordSharedConfig {
  agentManager: AgentManager;
  sessionStore: SessionStore;
  sessionStoreForAgent?: (agentId: string) => SessionStore;
  channels?: ChannelsConfig;
  threadBindings?: ThreadBindingConfig;
  threadBindingManager?: ThreadBindingManager;
  enableSubagentStreaming?: boolean;
  subagentShowToolCalls?: boolean;
  allowBots?: boolean;
  context?: ContextConfigFile;
  usageTracker?: UsageTracker;
}

/** Configuration for the DiscordTransportManager */
export interface DiscordTransportManagerConfig {
  accounts: Record<string, DiscordAccountConfigFile>;
  shared: DiscordSharedConfig;
}

/**
 * DiscordTransportManager — creates and manages multiple DiscordTransport instances.
 *
 * Each account in the config gets its own transport with an independent Client,
 * token, and identity. Account-level overrides (allowDMs, channelAllowlist,
 * defaultAgentId, agentBindings) take precedence over shared settings.
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
      const token = getDiscordToken(account);
      const shared = this.config.shared;

      const transport = new DiscordTransport({
        token,
        agentManager: shared.agentManager,
        sessionStore: shared.sessionStore,
        sessionStoreForAgent: shared.sessionStoreForAgent,
        defaultAgentId: account.defaultAgentId,
        agentBindings: account.agentBindings,
        allowDMs: account.allowDMs ?? shared.allowBots,
        channelAllowlist: account.channelAllowlist,
        channels: shared.channels,
        accountId,
        threadBindings: shared.threadBindings,
        threadBindingManager: shared.threadBindingManager,
        enableSubagentStreaming: shared.enableSubagentStreaming,
        subagentShowToolCalls: shared.subagentShowToolCalls,
        allowBots: shared.allowBots,
        context: shared.context,
        usageTracker: shared.usageTracker,
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
