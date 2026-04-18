// src/skills/bundled-dir.ts — Resolve the bundled skills directory
// Finds the `skills/` folder at the package root for built-in skills.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../core/logger.js";

const log = createLogger("skills:bundled-dir");

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SKILL_FILE = "SKILL.md";

/**
 * Check whether a directory looks like a valid skills directory.
 * Must contain at least one subdirectory with a SKILL.md file.
 */
export function looksLikeSkillsDir(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.some(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        fs.existsSync(path.join(dir, entry.name, SKILL_FILE)),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cache — computed once, cleared only in tests
// ---------------------------------------------------------------------------

/** null = not yet computed, undefined = computed but nothing found */
let cached: string | undefined | null = null;

/**
 * Clear the cached result. Call in tests to reset state.
 */
export function clearBundledSkillsCache(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the bundled skills directory.
 *
 * Resolution order:
 * 1. `ISOTOPES_BUNDLED_SKILLS_DIR` env override (validated — must exist and look like a skills dir)
 * 2. Walk up from this module to find package root (`package.json`), then check `{root}/skills/`
 *
 * Returns `undefined` if no valid bundled skills directory is found.
 * Result is cached after the first call.
 */
export function resolveBundledSkillsDir(): string | undefined {
  if (cached !== null) return cached;
  cached = resolve();
  return cached;
}

function resolve(): string | undefined {
  // 1. Env override with validation
  const envDir = process.env.ISOTOPES_BUNDLED_SKILLS_DIR?.trim();
  if (envDir) {
    if (!fs.existsSync(envDir)) {
      log.warn(`ISOTOPES_BUNDLED_SKILLS_DIR="${envDir}" does not exist — ignoring`);
    } else if (!looksLikeSkillsDir(envDir)) {
      log.warn(`ISOTOPES_BUNDLED_SKILLS_DIR="${envDir}" does not look like a skills directory — ignoring`);
    } else {
      log.debug(`Using bundled skills from env override: ${envDir}`);
      return envDir;
    }
  }

  // 2. Walk up from this file to find package.json → {root}/skills/
  try {
    let current = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(path.join(current, "package.json"))) {
        const candidate = path.join(current, "skills");
        if (looksLikeSkillsDir(candidate)) {
          log.debug(`Found bundled skills at: ${candidate}`);
          return candidate;
        }
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch {
    // fs errors — skip
  }

  return undefined;
}
