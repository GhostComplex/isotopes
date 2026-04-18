// src/core/claude-settings.ts — Reuse Claude Code's settings.json env block
// so isotopes (and the @anthropic-ai/claude-agent-sdk subagent) can pick up the
// same ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / model overrides without
// duplicating them in .env.local. Existing process.env values always win, so
// .env.local and shell exports keep priority.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "./logger.js";

const log = createLogger("claude-settings");

export function loadClaudeSettingsEnv(
  path = process.env.CLAUDE_SETTINGS_PATH ?? join(homedir(), ".claude", "settings.json"),
): void {
  if (!existsSync(path)) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    log.warn(`Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const env = (parsed as { env?: Record<string, unknown> } | null)?.env;
  if (!env || typeof env !== "object") return;

  let applied = 0;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (process.env[key] !== undefined) continue; // existing env wins
    process.env[key] = value;
    applied++;
  }
  if (applied > 0) log.info(`Loaded ${applied} env var(s) from ${path}`);
}
