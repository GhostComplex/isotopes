import fs from "node:fs";
import path from "node:path";
import { getIsotopesHome } from "../../utils/paths.js";

export interface UIEntry {
  id: string;
  staticDir: string;
  mountPath: string;
  spaFallback: boolean;
}

/** Scan ~/.isotopes/extensions/ui/<id>/ — each subdirectory becomes a mounted SPA at /ui/<id>. */
export function discoverUIEntries(): UIEntry[] {
  const root = path.join(getIsotopesHome(), "extensions", "ui");
  if (!fs.existsSync(root)) return [];
  const entries: UIEntry[] = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const staticDir = path.join(root, e.name);
    entries.push({
      id: e.name,
      staticDir,
      mountPath: `/ui/${e.name}`,
      spaFallback: true,
    });
  }
  return entries;
}

export function matchUIEntry(entries: UIEntry[], pathname: string): UIEntry | undefined {
  for (const e of entries) {
    if (pathname === e.mountPath || pathname.startsWith(e.mountPath + "/")) return e;
  }
  return undefined;
}
