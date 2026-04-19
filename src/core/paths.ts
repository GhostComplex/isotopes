// src/core/paths.ts — Directory and path management for Isotopes
// Centralizes all path logic for consistent directory structure.

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The default agent ID used for single-agent setups. */
const DEFAULT_AGENT_ID = "default";

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
 * Layout mirrors OpenClaw:
 * - Default agent: ~/.isotopes/workspace/
 * - Named agent:   ~/.isotopes/workspace-{agentId}/
 */
export function getWorkspacePath(agentId: string): string {
  if (agentId === DEFAULT_AGENT_ID) {
    return path.join(getIsotopesHome(), "workspace");
  }
  return path.join(getIsotopesHome(), `workspace-${agentId}`);
}

/**
 * Get the sessions directory for an agent (inside workspace).
 */
export function getSessionsDir(agentId: string): string {
  return path.join(getWorkspacePath(agentId), "sessions");
}

/**
 * Get the directory holding subagent run transcripts.
 * One JSONL per run lives under here (keyed by virtual agentId =
 * `subagent:<parentAgentId>:<taskId>`). See docs/subagent-persistence.md.
 */
export function getSubagentSessionsDir(): string {
  return path.join(getIsotopesHome(), "subagent-sessions");
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
  await fs.mkdir(getSessionsDir(agentId), { recursive: true });
  return workspacePath;
}

/**
 * Ensure an explicit workspace directory exists (#214).
 * Creates the workspace and a sessions/ subdirectory.
 */
export async function ensureExplicitWorkspaceDir(resolvedPath: string): Promise<string> {
  await fs.mkdir(resolvedPath, { recursive: true });
  await fs.mkdir(path.join(resolvedPath, "sessions"), { recursive: true });
  return resolvedPath;
}

