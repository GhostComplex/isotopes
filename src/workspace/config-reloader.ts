// src/workspace/config-reloader.ts — Auto-reload config on file changes
// Watches the Isotopes config file and reloads it when modified.

import { createLogger } from "../core/logger.js";
import { loadConfig, type IsotopesConfigFile } from "../core/config.js";
import { WorkspaceWatcher, type FileChange } from "./watcher.js";

const log = createLogger("config-reloader");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConfigReloadListener = (config: IsotopesConfigFile) => void;

// ---------------------------------------------------------------------------
// ConfigReloader
// ---------------------------------------------------------------------------

export class ConfigReloader {
  private watcher: WorkspaceWatcher;
  private currentConfig: IsotopesConfigFile | null = null;
  private listeners: ConfigReloadListener[] = [];
  private configPath: string;

  constructor(configPath: string) {
    this.configPath = configPath;

    this.watcher = new WorkspaceWatcher({
      paths: [configPath],
      debounceMs: 200,
    });
  }

  /**
   * Start watching the config file.
   * Loads the initial config and begins watching for changes.
   */
  async start(): Promise<void> {
    // Load initial config
    this.currentConfig = await loadConfig(this.configPath);
    log.info(`Loaded initial config from ${this.configPath}`);

    // Watch for changes
    this.watcher.onChange((changes: FileChange[]) => {
      void this.handleChanges(changes);
    });

    this.watcher.start();
  }

  /**
   * Stop watching the config file.
   */
  stop(): void {
    this.watcher.stop();
    log.info("Config reloader stopped");
  }

  /**
   * Get the current loaded config. Returns null if not yet loaded.
   */
  getConfig(): IsotopesConfigFile | null {
    return this.currentConfig;
  }

  /**
   * Register a listener for config reload events.
   * Returns an unsubscribe function.
   */
  onReload(listener: ConfigReloadListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async handleChanges(_changes: FileChange[]): Promise<void> {
    log.info(`Config file changed, reloading ${this.configPath}`);

    try {
      const newConfig = await loadConfig(this.configPath);
      this.currentConfig = newConfig;

      log.info("Config reloaded successfully");

      // Notify listeners
      for (const listener of this.listeners) {
        try {
          listener(newConfig);
        } catch (err) {
          log.error("Error in config reload listener:", err);
        }
      }
    } catch (err) {
      log.error("Failed to reload config (keeping previous config):", err);
      // Keep the previous valid config
    }
  }
}
