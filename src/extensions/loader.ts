import fs from "node:fs";
import path from "node:path";
import { getIsotopesHome } from "../paths.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("extensions");

/** Scan ~/.isotopes/extensions/*.ts and return absolute paths.
 * Files are loaded by pi-coding-agent's ResourceLoader (jiti). */
export function discoverExtensionPaths(): string[] {
  const dir = path.join(getIsotopesHome(), "extensions");
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const paths: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!/\.(ts|js|mts|mjs)$/.test(e.name)) continue;
    paths.push(path.join(dir, e.name));
  }
  if (paths.length > 0) {
    log.info(`Discovered ${paths.length} extension(s) in ${dir}`);
  }
  return paths;
}
