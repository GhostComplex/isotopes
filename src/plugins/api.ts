// src/plugins/api.ts — Scoped plugin API factory

import path from "node:path";
import { createLogger } from "../core/logger.js";
import type { HookRegistry } from "./hooks.js";
import type { UIRegistry } from "./ui-registry.js";
import type { ToolPluginRegistry } from "./tool-registry.js";
import type { Tool } from "../core/types.js";
import type { ToolHandler } from "../core/tools.js";
import type {
  IsotopesPluginApi,
  TransportFactory,
  UIPluginConfig,
  PluginManifest,
  PluginToolFactory,
} from "./types.js";

export interface CreatePluginApiDeps {
  hooks: HookRegistry;
  uiRegistry: UIRegistry;
  transportFactories: Map<string, TransportFactory>;
  toolPluginRegistry: ToolPluginRegistry;
  pluginConfig?: Record<string, unknown>;
}

export interface CreatePluginApiResult {
  api: IsotopesPluginApi;
  cleanup: Array<() => void>;
}

export function createPluginApi(
  manifest: PluginManifest,
  pluginDir: string,
  deps: CreatePluginApiDeps,
): CreatePluginApiResult {
  const cleanup: Array<() => void> = [];
  const log = createLogger(`plugin:${manifest.id}`);

  const api: IsotopesPluginApi = {
    registerTransport(id: string, factory: TransportFactory): void {
      deps.transportFactories.set(id, factory);
      cleanup.push(() => deps.transportFactories.delete(id));
      log.info(`Registered transport "${id}"`);
    },

    registerUI(config: UIPluginConfig): void {
      const resolved: UIPluginConfig = {
        ...config,
        staticDir: path.resolve(pluginDir, config.staticDir),
      };
      deps.uiRegistry.register(resolved);
      log.info(`Registered UI "${config.id}" at ${resolved.mountPath ?? `/ui/${config.id}`}`);
    },

    registerTool(
      tool: { tool: Tool; handler: ToolHandler } | PluginToolFactory,
    ): void {
      const factory: PluginToolFactory =
        typeof tool === "function" ? tool : () => tool;
      deps.toolPluginRegistry.register(manifest.id, factory);
      cleanup.push(() => deps.toolPluginRegistry.remove(manifest.id));
      log.info(`Registered tool from plugin "${manifest.id}"`);
    },

    on(hook, handler) {
      const unsub = deps.hooks.on(hook, handler);
      cleanup.push(unsub);
      return unsub;
    },

    getConfig(): Record<string, unknown> | undefined {
      return deps.pluginConfig;
    },

    log,
  };

  return { api, cleanup };
}
