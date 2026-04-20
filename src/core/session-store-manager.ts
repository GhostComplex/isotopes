// src/core/session-store-manager.ts — Per-agentId SessionStore registry
//
// One DefaultSessionStore per agentId, rooted at
// ~/.isotopes/agents/<normalizedAgentId>/sessions/. Used by both the main
// agent write path (via DiscordTransport / sessionStoreForAgent) and the
// subagent write path (via createSubagentRecorder). See
// docs/subagent-architecture.md §4.4.

import { DefaultSessionStore } from "./session-store.js";
import {
  ensureAgentSessionsDir,
  getAgentSessionsDir,
  normalizeAgentId,
} from "./paths.js";
import type { SessionConfig } from "./types.js";
import { createLogger } from "./logger.js";
import type { HookRegistry } from "../plugins/hooks.js";

const log = createLogger("session-store-manager");

export interface SessionStoreManagerOptions {
  /** Per-store session config (TTL, cleanup interval). */
  session?: SessionConfig;
  /** Per-store maxSessions cap (defaults to DefaultSessionStore default). */
  maxSessions?: number;
  /** Per-store maxTotalSizeMB cap (defaults to DefaultSessionStore default). */
  maxTotalSizeMB?: number;
  /** Hook registry for lifecycle events. */
  hooks?: HookRegistry;
}

/**
 * Lazily creates and memoizes one DefaultSessionStore per normalized
 * agentId. Stores are not init()'d until requested.
 */
export class SessionStoreManager {
  private stores = new Map<string, DefaultSessionStore>();
  private inits = new Map<string, Promise<DefaultSessionStore>>();

  constructor(private readonly opts: SessionStoreManagerOptions = {}) {}

  /**
   * Get or create the store for an agentId. Returns a fully init()'d store.
   * Concurrent calls for the same agentId share one initialization.
   */
  async getOrCreate(agentId: string): Promise<DefaultSessionStore> {
    const key = normalizeAgentId(agentId);

    const existing = this.stores.get(key);
    if (existing) return existing;

    const pending = this.inits.get(key);
    if (pending) return pending;

    const init = (async () => {
      const dataDir = await ensureAgentSessionsDir(agentId);
      const store = new DefaultSessionStore({
        dataDir,
        ...(this.opts.maxSessions !== undefined ? { maxSessions: this.opts.maxSessions } : {}),
        ...(this.opts.maxTotalSizeMB !== undefined ? { maxTotalSizeMB: this.opts.maxTotalSizeMB } : {}),
        ...(this.opts.session ? { session: this.opts.session } : {}),
      });
      await store.init();
      this.stores.set(key, store);
      this.inits.delete(key);
      log.debug(`Initialized session store for agent ${agentId} at ${dataDir}`);
      if (this.opts.hooks) {
        await this.opts.hooks.emit("session_start", { agentId, sessionId: key });
      }
      return store;
    })();

    this.inits.set(key, init);
    return init;
  }

  /**
   * Synchronous lookup — returns the store if it has already been created,
   * otherwise undefined. Use this in hot paths that already know the store
   * exists; otherwise prefer getOrCreate().
   */
  peek(agentId: string): DefaultSessionStore | undefined {
    return this.stores.get(normalizeAgentId(agentId));
  }

  /** Snapshot of all currently-initialized stores keyed by normalizedId. */
  all(): Map<string, DefaultSessionStore> {
    return new Map(this.stores);
  }

  /** Tear down every initialized store. Safe to call multiple times. */
  destroyAll(): void {
    for (const [key, store] of this.stores) {
      if (this.opts.hooks) {
        this.opts.hooks.emit("session_end", { agentId: key, sessionId: key }).catch(() => {});
      }
      store.destroy();
    }
    this.stores.clear();
    this.inits.clear();
  }

  /** Convenience: directory path the store for `agentId` would use. */
  static dirFor(agentId: string): string {
    return getAgentSessionsDir(agentId);
  }
}
