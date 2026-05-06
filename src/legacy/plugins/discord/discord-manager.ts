// src/plugins/discord/discord-manager.ts — Manages multiple DiscordTransport instances
// Each Discord bot account gets its own transport (Client, token, identity).

import type {
  SessionStore,
} from "../../../sessions/types.js";
import type { DiscordAccountConfig } from "./types.js";
import type { AgentRuntime } from "../../../agent/runtime.js";
import { getDiscordToken } from "./config.js";
import { DiscordTransport } from "./discord.js";
import { ThreadBindingManager } from "./thread-bindings.js";
import { createLogger } from "../../../logging/logger.js";

const log = createLogger("discord-manager");

/** Shared infrastructure injected into every Discord account transport. */
export interface DiscordSharedConfig {
  /** Unified runtime — required at runtime; optional only for unit tests. */
  agentRuntime?: AgentRuntime;
  sessionStore: SessionStore;
  sessionStoreForAgent?: (agentId: string) => SessionStore;
  threadBindingManager?: ThreadBindingManager;
}

/** Configuration for the DiscordTransportManager */
export interface DiscordTransportManagerConfig {
  accounts: Record<string, DiscordAccountConfig>;
  shared: DiscordSharedConfig;
}

/** Multi-account Discord transports — one Client per account. */
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
        ...(shared.agentRuntime ? { agentRuntime: shared.agentRuntime } : {}),
        sessionStore: shared.sessionStore,
        sessionStoreForAgent: shared.sessionStoreForAgent,
        defaultAgentId: account.defaultAgentId,
        agentBindings: account.agentBindings,
        dmAccess: account.dmAccess,
        groupAccess: account.groupAccess,
        guilds: account.guilds,
        threadBindings: account.threadBindings,
        threadBindingManager: shared.threadBindingManager,
        allowBots: account.allowBots,
        context: account.context,
        adminUsers: account.adminUsers,
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
