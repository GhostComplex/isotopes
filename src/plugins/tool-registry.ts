// src/plugins/tool-registry.ts — Collects plugin tool registrations and resolves them per-agent

import type { ToolEntry } from "../core/tools.js";
import type { PluginToolContext, PluginToolFactory } from "./types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("plugins:tools");

interface ToolPluginEntry {
  pluginId: string;
  factory: PluginToolFactory;
}

export class ToolPluginRegistry {
  private entries: ToolPluginEntry[] = [];

  register(pluginId: string, factory: PluginToolFactory): void {
    this.entries.push({ pluginId, factory });
  }

  resolve(ctx: PluginToolContext): ToolEntry[] {
    const results: ToolEntry[] = [];
    const seen = new Set<string>();

    for (const entry of this.entries) {
      let resolved;
      try {
        resolved = entry.factory(ctx);
      } catch (err) {
        log.error(`Plugin tool factory failed (${entry.pluginId}): ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!resolved) continue;

      const list = Array.isArray(resolved) ? resolved : [resolved];
      for (const item of list) {
        if (seen.has(item.tool.name)) {
          log.error(`Plugin tool name conflict (${entry.pluginId}): ${item.tool.name}`);
          continue;
        }
        seen.add(item.tool.name);
        results.push(item);
      }
    }
    return results;
  }

  remove(pluginId: string): void {
    this.entries = this.entries.filter((e) => e.pluginId !== pluginId);
  }

  clear(): void {
    this.entries = [];
  }
}
