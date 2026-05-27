import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { readdirSync, existsSync as syncExistsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function getIsotopesHome(): string {
  return process.env.ISOTOPES_HOME || path.join(os.homedir(), ".isotopes");
}

export function getLogsDir(): string {
  return path.join(getIsotopesHome(), "logs");
}

export function getWorkspacePath(agentId: string): string {
  return path.join(getIsotopesHome(), `workspace-${agentId}`);
}

/** Lowercases and replaces any character outside `[a-z0-9_-]` with `-`. */
export function normalizeAgentId(agentId: string): string {
  return agentId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

export function getAgentSessionsDir(agentId: string): string {
  return path.join(getIsotopesHome(), "agents", normalizeAgentId(agentId), "sessions");
}

export async function ensureAgentSessionsDir(agentId: string): Promise<string> {
  const dir = getAgentSessionsDir(agentId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function getConfigPath(): string {
  return path.join(getIsotopesHome(), "isotopes.yaml");
}

export function resolveAgentWorkspacePath(config: { id: string; workspace?: string }): string {
  if (config.workspace) {
    return path.isAbsolute(config.workspace)
      ? config.workspace
      : path.resolve(getIsotopesHome(), config.workspace);
  }
  return getWorkspacePath(config.id);
}

export async function ensureWorkspaceDir(agentId: string): Promise<string> {
  const workspacePath = getWorkspacePath(agentId);
  await fs.mkdir(workspacePath, { recursive: true });
  return workspacePath;
}

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

/** Override with ISOTOPES_BUILTIN_SKILLS_DIR (or legacy ISOTOPES_BUNDLED_SKILLS_DIR). */
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
