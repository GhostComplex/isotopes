import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function getIsotopesHome(): string {
  return process.env.ISOTOPES_HOME || path.join(os.homedir(), ".isotopes");
}

export function getLogsDir(): string {
  return path.join(getIsotopesHome(), "logs");
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
  return path.join(getIsotopesHome(), `workspace-${config.id}`);
}

export function resolveBuiltinSkillsDir(): string | undefined {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const candidate = path.join(pkgRoot, "skills");
  return existsSync(candidate) ? candidate : undefined;
}
