// src/workspace/hot-reload.ts — Hot-reload system for workspace files
// Watches workspace files and triggers agent reload when they change.

import path from "node:path";
import { createLogger } from "../core/logger.js";
import type { AgentManager } from "../core/types.js";
import { WorkspaceWatcher } from "./watcher.js";

const log = createLogger("hot-reload");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the hot-reload system. */
export interface HotReloadConfig {
  /** Whether hot-reload is enabled */
  enabled: boolean;
  /** Debounce time in ms before reloading. Default: 500 */
  debounceMs?: number;
}

/** Event emitted when workspace is reloaded. */
export interface WorkspaceReloadedEvent {
  type: "workspace_reloaded";
  agentId: string;
  changedFiles: string[];
  timestamp: Date;
}

/** Callback for reload events. */
export type ReloadEventHandler = (event: WorkspaceReloadedEvent) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Files to watch
// ---------------------------------------------------------------------------

/** Workspace files that trigger a reload when changed. */
export const WATCHED_PATTERNS = [
  "SOUL.md",
  "USER.md",
  "TOOLS.md",
  "AGENTS.md",
  "MEMORY.md",
  "memory/*.md",
  "skills/**/*.md",
  "skills/**/*.yaml",
  "skills/**/*.yml",
];

/** Patterns to ignore. */
export const IGNORE_PATTERNS = [
  "node_modules",
  ".git",
  "sessions",
  "*.bak",
  "*.tmp",
];

// ---------------------------------------------------------------------------
// HotReloadManager
// ---------------------------------------------------------------------------

/**
 * HotReloadManager — watches workspace files and triggers agent reloads.
 *
 * When workspace files (SOUL.md, MEMORY.md, skills, etc.) change, this
 * manager detects the change and reloads the agent's workspace context
 * without requiring a restart.
 */
export class HotReloadManager {
  private watchers = new Map<string, WorkspaceWatcher>();
  private agentWorkspaces = new Map<string, string>(); // agentId -> workspacePath
  private eventHandlers: ReloadEventHandler[] = [];
  private started = false;

  constructor(
    private agentManager: AgentManager,
    private config: HotReloadConfig = { enabled: true },
  ) {}

  /**
   * Register an agent's workspace for hot-reload.
   * @param agentId Agent identifier
   * @param workspacePath Path to the agent's workspace directory
   */
  register(agentId: string, workspacePath: string): void {
    if (this.agentWorkspaces.has(agentId)) {
      log.warn(`Agent "${agentId}" already registered for hot-reload`);
      return;
    }

    this.agentWorkspaces.set(agentId, workspacePath);
    log.debug(`Registered agent "${agentId}" for hot-reload: ${workspacePath}`);

    // If already started, create watcher immediately
    if (this.started && this.config.enabled) {
      this.createWatcher(agentId, workspacePath);
    }
  }

  /**
   * Unregister an agent from hot-reload.
   */
  unregister(agentId: string): void {
    const watcher = this.watchers.get(agentId);
    if (watcher) {
      watcher.stop();
      this.watchers.delete(agentId);
    }
    this.agentWorkspaces.delete(agentId);
    log.debug(`Unregistered agent "${agentId}" from hot-reload`);
  }

  /**
   * Start watching all registered workspaces.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    if (!this.config.enabled) {
      log.info("Hot-reload disabled by config");
      return;
    }

    for (const [agentId, workspacePath] of this.agentWorkspaces) {
      this.createWatcher(agentId, workspacePath);
    }

    log.info(`Hot-reload manager started (${this.agentWorkspaces.size} agent(s))`);
  }

  /**
   * Stop watching all workspaces.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    for (const watcher of this.watchers.values()) {
      watcher.stop();
    }
    this.watchers.clear();

    log.info("Hot-reload manager stopped");
  }

  /**
   * Manually trigger a workspace reload for an agent.
   */
  async reload(agentId: string): Promise<void> {
    const workspacePath = this.agentWorkspaces.get(agentId);
    if (!workspacePath) {
      throw new Error(`Agent "${agentId}" not registered for hot-reload`);
    }

    log.info(`Manually reloading workspace for agent "${agentId}"`);
    await this.reloadAgent(agentId, ["manual"]);
  }

  /**
   * Manually trigger reload for all registered agents.
   */
  async reloadAll(): Promise<void> {
    const promises = Array.from(this.agentWorkspaces.keys()).map((agentId) =>
      this.reload(agentId),
    );
    await Promise.all(promises);
  }

  /**
   * Register an event handler for reload events.
   */
  onReload(handler: ReloadEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const idx = this.eventHandlers.indexOf(handler);
      if (idx !== -1) this.eventHandlers.splice(idx, 1);
    };
  }

  /**
   * Check if hot-reload is active.
   */
  isActive(): boolean {
    return this.started && this.config.enabled;
  }

  /**
   * Get list of registered agents.
   */
  getRegisteredAgents(): string[] {
    return Array.from(this.agentWorkspaces.keys());
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private createWatcher(agentId: string, workspacePath: string): void {
    const watcher = new WorkspaceWatcher({
      paths: [workspacePath],
      patterns: WATCHED_PATTERNS,
      ignorePatterns: IGNORE_PATTERNS,
      debounceMs: this.config.debounceMs ?? 500,
    });

    watcher.onChange(async (changes) => {
      const filenames = changes.map((c) => path.relative(workspacePath, c.path));
      log.info(`Detected ${changes.length} change(s) in workspace for "${agentId}": ${filenames.join(", ")}`);
      await this.reloadAgent(agentId, filenames);
    });

    watcher.start();
    this.watchers.set(agentId, watcher);
  }

  private async reloadAgent(agentId: string, changedFiles: string[]): Promise<void> {
    try {
      await this.agentManager.reloadWorkspace(agentId);

      const event: WorkspaceReloadedEvent = {
        type: "workspace_reloaded",
        agentId,
        changedFiles,
        timestamp: new Date(),
      };

      log.info(`Workspace reloaded for agent "${agentId}"`);

      // Notify event handlers
      for (const handler of this.eventHandlers) {
        try {
          await handler(event);
        } catch (err) {
          log.error("Error in reload event handler:", err);
        }
      }
    } catch (err) {
      log.error(`Failed to reload workspace for agent "${agentId}":`, err);
    }
  }
}
