// src/plugins/ui-registry.ts — Registry for UI plugin static file mounts

import path from "node:path";
import fs from "node:fs";
import type { UIPluginConfig } from "./types.js";

export class UIRegistry {
  private entries = new Map<string, UIPluginConfig>();

  register(config: UIPluginConfig): void {
    const resolved = {
      ...config,
      staticDir: path.resolve(config.staticDir),
      mountPath: config.mountPath ?? `/ui/${config.id}`,
    };

    if (!fs.existsSync(resolved.staticDir)) {
      throw new Error(
        `UI plugin "${config.id}": staticDir does not exist: ${resolved.staticDir}`,
      );
    }

    this.entries.set(config.id, resolved);
  }

  get(id: string): UIPluginConfig | undefined {
    return this.entries.get(id);
  }

  list(): UIPluginConfig[] {
    return [...this.entries.values()];
  }

  match(pathname: string): UIPluginConfig | undefined {
    for (const entry of this.entries.values()) {
      const mount = entry.mountPath!;
      if (pathname === mount || pathname.startsWith(mount + "/")) {
        return entry;
      }
    }
    return undefined;
  }
}
