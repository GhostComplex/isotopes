// src/paths.ts — Directory and path management for Isotopes
// Centralizes all path logic for consistent directory structure.

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { readdirSync, existsSync as syncExistsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Base directories
// ---------------------------------------------------------------------------

/**
 * Get the Isotopes home directory.
 * Default: ~/.isotopes
 * Override: ISOTOPES_HOME environment variable
 */
export function getIsotopesHome(): string {
  return process.env.ISOTOPES_HOME || path.join(os.homedir(), ".isotopes");
}

/**
 * Get the logs directory.
 * Default: ~/.isotopes/logs
 */
export function getLogsDir(): string {
  return path.join(getIsotopesHome(), "logs");
}

// ---------------------------------------------------------------------------
// Workspace paths
// ---------------------------------------------------------------------------

/**
 * Get the workspace directory for an agent.
 *
 * All agents use: ~/.isotopes/workspace-{agentId}/
 */
export function getWorkspacePath(agentId: string): string {
  return path.join(getIsotopesHome(), `workspace-${agentId}`);
}

/**
 * Normalize an agentId for use as a filesystem directory name.
 * Lowercases and replaces any character outside `[a-z0-9_-]` with `-`.
 */
export function normalizeAgentId(agentId: string): string {
  return agentId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

/**
 * Get the sessions directory for an agent.
 *
 * All transcripts (main agent + spawn agent runs targeting this agent) live
 * under `~/.isotopes/agents/<normalizedAgentId>/sessions/`.
 */
export function getAgentSessionsDir(agentId: string): string {
  return path.join(getIsotopesHome(), "agents", normalizeAgentId(agentId), "sessions");
}

/** Ensure an agent's sessions directory exists, returning its absolute path. */
export async function ensureAgentSessionsDir(agentId: string): Promise<string> {
  const dir = getAgentSessionsDir(agentId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Config paths
// ---------------------------------------------------------------------------

/**
 * Get the config file path.
 * Fixed location: ~/.isotopes/isotopes.yaml
 */
export function getConfigPath(): string {
  return path.join(getIsotopesHome(), "isotopes.yaml");
}

// ---------------------------------------------------------------------------
// Directory initialization
// ---------------------------------------------------------------------------

/**
 * Ensure required directories exist.
 */
export async function ensureDirectories(): Promise<void> {
  await fs.mkdir(getIsotopesHome(), { recursive: true });
  await fs.mkdir(getLogsDir(), { recursive: true });
}

/**
 * Resolve an explicit workspace path (#214).
 * Absolute paths are returned as-is; relative paths resolve from ISOTOPES_HOME.
 */
export function resolveExplicitWorkspacePath(workspacePath: string): string {
  if (path.isAbsolute(workspacePath)) {
    return workspacePath;
  }
  return path.resolve(getIsotopesHome(), workspacePath);
}

/**
 * Resolve the workspace directory for an agent given its config.
 * Pure — returns the path; doesn't touch the filesystem.
 */
export function resolveAgentWorkspacePath(config: { id: string; workspace?: string }): string {
  if (config.workspace) return resolveExplicitWorkspacePath(config.workspace);
  return getWorkspacePath(config.id);
}

/**
 * Ensure workspace directory exists for an agent.
 */
export async function ensureWorkspaceDir(agentId: string): Promise<string> {
  const workspacePath = getWorkspacePath(agentId);
  await fs.mkdir(workspacePath, { recursive: true });
  return workspacePath;
}

/**
 * Ensure an explicit workspace directory exists (#214).
 */
export async function ensureExplicitWorkspaceDir(resolvedPath: string): Promise<string> {
  await fs.mkdir(resolvedPath, { recursive: true });
  return resolvedPath;
}


// ---------------------------------------------------------------------------
// Bundled skills (shipped with the package)
// ---------------------------------------------------------------------------

function looksLikeSkillsDir(dir: string): boolean {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && syncExistsSync(path.join(dir, entry.name, "SKILL.md"))) {
        return true;
      }
    }
  } catch { /* unreadable */ }
  return false;
}

/** Resolve the built-in skills directory shipped with the package.
 *  Override with ISOTOPES_BUILTIN_SKILLS_DIR (or legacy ISOTOPES_BUNDLED_SKILLS_DIR). */
export function resolveBuiltinSkillsDir(): string | undefined {
  const override = (process.env.ISOTOPES_BUILTIN_SKILLS_DIR ?? process.env.ISOTOPES_BUNDLED_SKILLS_DIR)?.trim();
  if (override) return override;

  try {
    const thisFile = fileURLToPath(import.meta.url);
    let current = path.dirname(thisFile);
    for (let depth = 0; depth < 6; depth++) {
      const candidate = path.join(current, "skills");
      if (syncExistsSync(candidate) && looksLikeSkillsDir(candidate)) {
        return candidate;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch { /* silent */ }

  return undefined;
}
