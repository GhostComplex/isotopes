// src/plugins/index.ts — Plugin system barrel exports

export { PluginManager } from "./manager.js";
export { HookRegistry } from "./hooks.js";
export { UIRegistry } from "./ui-registry.js";
export { discoverPlugins } from "./discovery.js";
export { createPluginApi } from "./api.js";
export type {
  PluginManifest,
  IsotopesPlugin,
  IsotopesPluginModule,
  IsotopesPluginApi,
  HookName,
  HookPayloads,
  UIPluginConfig,
  TransportFactory,
  TransportFactoryContext,
  PluginConfigEntry,
} from "./types.js";
