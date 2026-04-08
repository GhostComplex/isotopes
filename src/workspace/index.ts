// src/workspace/index.ts — Barrel exports for the workspace watcher module

export { WorkspaceWatcher, globToRegExp, matchesPatterns, matchesIgnorePatterns } from "./watcher.js";
export type {
  WatcherConfig,
  FileChange,
  ChangeHandler,
} from "./watcher.js";

export { ConfigReloader } from "./config-reloader.js";
export type { ConfigReloadListener } from "./config-reloader.js";
