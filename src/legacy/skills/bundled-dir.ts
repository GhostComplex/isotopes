// src/skills/bundled-dir.ts — Resolve bundled skills directory
// Finds the `skills/` directory shipped with the isotopes package.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Check if a directory looks like it contains skills (has subdirs with SKILL.md).
 */
function looksLikeSkillsDir(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (fs.existsSync(path.join(dir, entry.name, "SKILL.md"))) {
          return true;
        }
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
  return false;
}

/**
 * Resolve the bundled skills directory by walking up from this module's location
 * to find the package root, then returning `{root}/skills/`.
 *
 * Returns undefined if no bundled skills directory is found.
 *
 * Override with ISOTOPES_BUNDLED_SKILLS_DIR env var.
 */
export function resolveBundledSkillsDir(): string | undefined {
  // Allow env override
  const override = process.env.ISOTOPES_BUNDLED_SKILLS_DIR?.trim();
  if (override) {
    return override;
  }

  // Walk up from this file to find package root (directory containing package.json)
  try {
    const thisFile = fileURLToPath(import.meta.url);
    let current = path.dirname(thisFile);

    for (let depth = 0; depth < 6; depth++) {
      const candidate = path.join(current, "skills");
      if (fs.existsSync(candidate) && looksLikeSkillsDir(candidate)) {
        return candidate;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch {
    // Silently fail
  }

  return undefined;
}
