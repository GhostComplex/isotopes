// src/core/paths.ts — Directory and path management for Isotopes
// Centralizes all path logic for consistent directory structure.

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

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
 * Get the workspaces directory.
 * Default: ~/.isotopes/workspaces
 */
export function getWorkspacesDir(): string {
  return path.join(getIsotopesHome(), "workspaces");
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
 * Default: ~/.isotopes/workspaces/<agentId>
 */
export function getWorkspacePath(agentId: string): string {
  return path.join(getWorkspacesDir(), agentId);
}

/**
 * Get the sessions directory for an agent (inside workspace).
 * Default: ~/.isotopes/workspaces/<agentId>/sessions
 */
export function getSessionsDir(agentId: string): string {
  return path.join(getWorkspacePath(agentId), "sessions");
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
  await fs.mkdir(getWorkspacesDir(), { recursive: true });
  await fs.mkdir(getLogsDir(), { recursive: true });
}

/**
 * Ensure workspace directory exists for an agent.
 */
export async function ensureWorkspaceDir(agentId: string): Promise<string> {
  const workspacePath = getWorkspacePath(agentId);
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(getSessionsDir(agentId), { recursive: true });
  return workspacePath;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a workspace path.
 * If relative, resolves to ~/.isotopes/workspaces/<path>
 * If absolute, uses as-is.
 */
export function resolveWorkspacePath(workspacePath: string): string {
  if (path.isAbsolute(workspacePath)) {
    return workspacePath;
  }
  return path.join(getWorkspacesDir(), workspacePath);
}
