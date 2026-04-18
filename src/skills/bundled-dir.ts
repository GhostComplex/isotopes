// src/skills/bundled-dir.ts — Resolve bundled skills directory
// Finds the `skills/` directory shipped with the isotopes package.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the bundled skills directory by walking up from this module
 * to find the package root (directory containing package.json),
 * then returning `{packageRoot}/skills/` if it exists.
 */
export function resolveBundledSkillsDir(
  moduleUrl?: string,
): string | undefined {
  // Skip in tests or when explicitly disabled
  if (process.env.ISOTOPES_SKIP_BUNDLED_SKILLS === "1") {
    return undefined;
  }

  // Allow env override
  const override = process.env.ISOTOPES_BUNDLED_SKILLS_DIR?.trim();
  if (override) {
    return override;
  }

  try {
    const url = moduleUrl ?? import.meta.url;
    let current = path.dirname(fileURLToPath(url));

    // Walk up to 6 levels to find package.json
    for (let depth = 0; depth < 6; depth++) {
      const pkgJson = path.join(current, "package.json");
      if (fs.existsSync(pkgJson)) {
        const candidate = path.join(current, "skills");
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          return candidate;
        }
        return undefined;
      }
      const next = path.dirname(current);
      if (next === current) break;
      current = next;
    }
  } catch {
    // ignore
  }

  return undefined;
}
