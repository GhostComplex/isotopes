// src/plugins/discovery.ts — Plugin discovery from filesystem

import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../core/logger.js";
import type { PluginManifest } from "./types.js";

const log = createLogger("plugins:discovery");

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  dir: string;
}

const MANIFEST_FILE = "isotopes.plugin.json";

export async function discoverPlugins(searchDirs: string[]): Promise<DiscoveredPlugin[]> {
  const results: DiscoveredPlugin[] = [];

  for (const searchDir of searchDirs) {
    try {
      await fs.access(searchDir);
    } catch {
      continue;
    }

    let entries: string[];
    try {
      entries = await fs.readdir(searchDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const pluginDir = path.join(searchDir, entry);
      const manifestPath = path.join(pluginDir, MANIFEST_FILE);

      try {
        const stat = await fs.stat(pluginDir);
        if (!stat.isDirectory()) continue;

        const raw = await fs.readFile(manifestPath, "utf-8");
        const manifest = JSON.parse(raw) as PluginManifest;

        if (!manifest.id || !manifest.name || !manifest.version || !manifest.entry) {
          log.warn(`Skipping plugin at ${pluginDir}: manifest missing required fields`);
          continue;
        }

        const entryResolved = path.resolve(pluginDir, manifest.entry);
        if (!entryResolved.startsWith(path.resolve(pluginDir))) {
          log.warn(`Skipping plugin "${manifest.id}": entry path escapes plugin directory`);
          continue;
        }

        results.push({ manifest, dir: pluginDir });
        log.debug(`Discovered plugin "${manifest.id}" at ${pluginDir}`);
      } catch {
        // No manifest or invalid JSON — skip silently
      }
    }
  }

  return results;
}
