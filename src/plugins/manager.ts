// src/plugins/manager.ts — Plugin lifecycle manager

import path from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger } from "../core/logger.js";
import { HookRegistry } from "./hooks.js";
import { UIRegistry } from "./ui-registry.js";
import { discoverPlugins } from "./discovery.js";
import { createPluginApi } from "./api.js";
import type {
  IsotopesPlugin,
  IsotopesPluginModule,
  PluginManifest,
  PluginConfigEntry,
  TransportFactory,
} from "./types.js";

const log = createLogger("plugins");

interface LoadedPlugin {
  manifest: PluginManifest;
  module: IsotopesPlugin;
  cleanup: Array<() => void>;
}

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>();
  private hooks = new HookRegistry();
  private uiRegistry = new UIRegistry();
  private transportFactories = new Map<string, TransportFactory>();

  async discoverAndLoad(
    searchDirs: string[],
    pluginConfigs?: Record<string, PluginConfigEntry>,
  ): Promise<void> {
    const discovered = await discoverPlugins(searchDirs);

    for (const { manifest, dir } of discovered) {
      const config = pluginConfigs?.[manifest.id];
      if (config?.enabled === false) {
        log.info(`Plugin "${manifest.id}" is disabled — skipping`);
        continue;
      }

      try {
        await this.loadPlugin(manifest, dir, config?.config);
      } catch (err) {
        log.error(
          `Failed to load plugin "${manifest.id}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    log.info(`Loaded ${this.plugins.size} plugin(s)`);
  }

  private async loadPlugin(
    manifest: PluginManifest,
    pluginDir: string,
    pluginConfig?: Record<string, unknown>,
  ): Promise<void> {
    const entryPath = path.resolve(pluginDir, manifest.entry);

    const mod = await import(pathToFileURL(entryPath).href);
    const pluginModule: IsotopesPluginModule = mod.default ?? mod;

    const plugin: IsotopesPlugin =
      typeof pluginModule === "function"
        ? { register: pluginModule }
        : pluginModule;

    const { api, cleanup } = createPluginApi(manifest, pluginDir, {
      hooks: this.hooks,
      uiRegistry: this.uiRegistry,
      transportFactories: this.transportFactories,
      pluginConfig,
    });

    await plugin.register(api);

    this.plugins.set(manifest.id, { manifest, module: plugin, cleanup });
    log.info(`Loaded plugin "${manifest.id}" v${manifest.version}`);
  }

  getHooks(): HookRegistry {
    return this.hooks;
  }

  getUIRegistry(): UIRegistry {
    return this.uiRegistry;
  }

  getTransportFactories(): Map<string, TransportFactory> {
    return this.transportFactories;
  }

  getLoadedPlugins(): PluginManifest[] {
    return [...this.plugins.values()].map((p) => p.manifest);
  }

  async shutdown(): Promise<void> {
    for (const [id, plugin] of this.plugins) {
      try {
        for (const fn of plugin.cleanup) fn();
        await plugin.module.unregister?.();
      } catch (err) {
        log.error(
          `Error shutting down plugin "${id}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.plugins.clear();
    this.hooks.clear();
  }
}
