// src/workspace/watcher.ts — File system watcher for workspace hot-reload
// Watches workspace files for changes and notifies registered handlers.

import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../core/logger.js";

const log = createLogger("watcher");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the file system watcher. */
export interface WatcherConfig {
  /** Paths to watch (files or directories) */
  paths: string[];
  /** Glob-style patterns to include (e.g., "*.yaml", "*.md"). If empty, all files match. */
  patterns?: string[];
  /** Patterns to ignore (e.g., "node_modules", ".git") */
  ignorePatterns?: string[];
  /** Debounce time in ms before notifying handlers. Default: 100 */
  debounceMs?: number;
}

/** A detected file system change event. */
export interface FileChange {
  /** Absolute path to the changed file */
  path: string;
  /** Type of change */
  type: "add" | "change" | "unlink";
  /** When the change was detected */
  timestamp: Date;
}

/** Callback invoked with batched file changes after debouncing. */
export type ChangeHandler = (changes: FileChange[]) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Pattern matching helpers
// ---------------------------------------------------------------------------

/** Cache for compiled glob patterns to avoid re-creating RegExp on every event. */
const globCache = new Map<string, RegExp>();

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports `*` (any chars except path sep) and `**` (any chars including path sep).
 * Results are cached for repeated calls with the same pattern.
 */
export function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;

  let regExpStr = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches everything including path separators
        regExpStr += ".*";
        i += 2;
        // Skip trailing / after **
        if (pattern[i] === "/") i++;
      } else {
        // * matches everything except path separators
        regExpStr += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      regExpStr += "[^/]";
      i++;
    } else if (ch === ".") {
      regExpStr += "\\.";
      i++;
    } else {
      regExpStr += ch;
      i++;
    }
  }

  const regex = new RegExp(`^${regExpStr}$`);
  globCache.set(pattern, regex);
  return regex;
}

/**
 * Check if a file path matches any of the given glob patterns.
 * If patterns array is empty or undefined, everything matches.
 */
export function matchesPatterns(filePath: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return true;

  const basename = path.basename(filePath);

  return patterns.some((pattern) => {
    // If pattern has path separators, match against full path
    if (pattern.includes("/")) {
      return globToRegExp(pattern).test(filePath);
    }
    // Otherwise match against basename only
    return globToRegExp(pattern).test(basename);
  });
}

/**
 * Check if a file path matches any ignore patterns.
 */
export function matchesIgnorePatterns(filePath: string, ignorePatterns?: string[]): boolean {
  if (!ignorePatterns || ignorePatterns.length === 0) return false;

  return ignorePatterns.some((pattern) => {
    // Check if any segment of the path matches the ignore pattern
    const segments = filePath.split(path.sep);
    const regex = globToRegExp(pattern);

    return segments.some((seg) => regex.test(seg)) || regex.test(filePath);
  });
}

// ---------------------------------------------------------------------------
// WorkspaceWatcher
// ---------------------------------------------------------------------------

/**
 * WorkspaceWatcher — watches workspace files for changes and notifies handlers.
 *
 * Uses Node.js `fs.watch` with recursive watching. Changes are debounced
 * and deduplicated (latest change per path wins) before being dispatched
 * to registered {@link ChangeHandler}s.
 */
export class WorkspaceWatcher {
  private watchers: fs.FSWatcher[] = [];
  private handlers: ChangeHandler[] = [];
  private pendingChanges: FileChange[] = [];
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private watching = false;

  constructor(private config: WatcherConfig) {}

  /**
   * Start watching the configured paths.
   * Begins listening for file system events and notifying handlers.
   */
  start(): void {
    if (this.watching) return;
    this.watching = true;

    const debounceMs = this.config.debounceMs ?? 100;

    for (const watchPath of this.config.paths) {
      try {
        const watcher = fs.watch(
          watchPath,
          { recursive: true },
          (eventType, filename) => {
            if (!filename) return;

            const fullPath = path.resolve(watchPath, filename);

            // Check ignore patterns
            if (matchesIgnorePatterns(fullPath, this.config.ignorePatterns)) {
              return;
            }
            if (matchesIgnorePatterns(filename, this.config.ignorePatterns)) {
              return;
            }

            // Check include patterns (use filename for relative path matching)
            if (!matchesPatterns(filename, this.config.patterns)) {
              return;
            }

            // Determine change type
            const changeType = this.resolveChangeType(fullPath, eventType);

            const change: FileChange = {
              path: fullPath,
              type: changeType,
              timestamp: new Date(),
            };

            this.pendingChanges.push(change);

            // Debounce: wait for quiet period before flushing
            if (this.debounceTimer) {
              clearTimeout(this.debounceTimer);
            }
            this.debounceTimer = setTimeout(() => {
              void this.flush();
            }, debounceMs);
          },
        );

        watcher.on("error", (err) => {
          log.error(`Watcher error for ${watchPath}:`, err);
        });

        this.watchers.push(watcher);
        log.info(`Watching ${watchPath}`);
      } catch (err) {
        log.error(`Failed to watch ${watchPath}:`, err);
      }
    }

    log.info(`Workspace watcher started (${this.watchers.length} path(s))`);
  }

  /**
   * Stop watching all paths. Clears pending changes and timers.
   */
  stop(): void {
    if (!this.watching) return;
    this.watching = false;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    this.pendingChanges = [];

    log.info("Workspace watcher stopped");
  }

  /**
   * Register a change handler. Returns an unsubscribe function.
   */
  onChange(handler: ChangeHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx !== -1) this.handlers.splice(idx, 1);
    };
  }

  /**
   * Whether the watcher is currently active.
   */
  isWatching(): boolean {
    return this.watching;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private resolveChangeType(
    fullPath: string,
    eventType: string,
  ): "add" | "change" | "unlink" {
    if (eventType === "rename") {
      // Check if file still exists
      try {
        fs.statSync(fullPath);
        // File exists — could be new or renamed-to
        return "add";
      } catch {
        // File does not exist — was deleted
        return "unlink";
      }
    }
    return "change";
  }

  private async flush(): Promise<void> {
    if (this.pendingChanges.length === 0) return;

    // Deduplicate: keep the latest change per path
    const byPath = new Map<string, FileChange>();
    for (const change of this.pendingChanges) {
      byPath.set(change.path, change);
    }

    const changes = [...byPath.values()];
    this.pendingChanges = [];

    log.debug(`Flushing ${changes.length} change(s)`);

    for (const handler of this.handlers) {
      try {
        await handler(changes);
      } catch (err) {
        log.error("Error in change handler:", err);
      }
    }
  }
}
