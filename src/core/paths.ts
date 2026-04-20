// src/core/paths.ts — Directory and path management for Isotopes
// Centralizes all path logic for consistent directory structure.

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

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
 * All transcripts (main agent + subagent runs targeting this agent) live
 * under `~/.isotopes/agents/<normalizedAgentId>/sessions/`. See
 * docs/subagent-architecture.md §4.4.
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

/**
 * Get the thread bindings file path.
 * Fixed location: ~/.isotopes/thread-bindings.json
 */
export function getThreadBindingsPath(): string {
  return path.join(getIsotopesHome(), "thread-bindings.json");
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

