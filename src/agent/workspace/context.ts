import fs from "node:fs/promises";
import path from "node:path";
import { loadSkills, formatSkillsForPrompt } from "@mariozechner/pi-coding-agent";
import { getIsotopesHome, getAgentWorkspacePath, getBuiltinSkillsPath } from "../../utils/paths.js";
import type { AgentConfig } from "../types.js";
import { createLogger } from "../../logging/logger.js";

const log = createLogger("skills");

export const WORKSPACE_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "AGENTS.md",
  "BOOTSTRAP.md",
] as const;

export const MEMORY_FILES = [
  "MEMORY.md",
] as const;

export interface WorkspaceContext {
  systemPromptAdditions: string;
  memory: string | null;
  workspacePath: string;
  skillsPrompt: string;
}

export async function loadWorkspaceContext(workspacePath: string, options?: { builtinSkillsPath?: string }): Promise<WorkspaceContext> {
  const additions: string[] = [];

  for (const filename of WORKSPACE_FILES) {
    const content = await readFileIfExists(path.join(workspacePath, filename));
    if (content) {
      additions.push(`## ${filename}\n\n${content}`);
    }
  }

  let memory: string | null = null;
  memory = await readFileIfExists(path.join(workspacePath, "MEMORY.md"));

  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
  const yesterdayMemory = await readFileIfExists(path.join(workspacePath, "memory", `${yesterday}.md`));
  if (yesterdayMemory) {
    memory = memory ? `${memory}\n\n## Yesterday's Notes\n\n${yesterdayMemory}` : `## Yesterday's Notes\n\n${yesterdayMemory}`;
  }

  const today = new Date().toISOString().split("T")[0];
  const dailyMemory = await readFileIfExists(path.join(workspacePath, "memory", `${today}.md`));
  if (dailyMemory) {
    memory = memory ? `${memory}\n\n## Today's Notes\n\n${dailyMemory}` : `## Today's Notes\n\n${dailyMemory}`;
  }

  const skillResult = loadSkills({
    cwd: workspacePath,
    agentDir: getIsotopesHome(),
    skillPaths: [
      path.join(workspacePath, "skills"),
      path.join(getIsotopesHome(), "skills"),
      ...(options?.builtinSkillsPath ? [options.builtinSkillsPath] : []),
    ],
    includeDefaults: false,
  });
  for (const d of skillResult.diagnostics) {
    log.warn(`skill ${d.type}: ${d.message}`, { path: d.path });
  }
  const skillsPrompt = formatSkillsForPrompt(skillResult.skills);

  return {
    systemPromptAdditions: additions.join("\n\n"),
    memory,
    workspacePath,
    skillsPrompt,
  };
}

export function buildSystemPrompt(workspace: WorkspaceContext | null): string {
  if (!workspace) return "";

  const parts: string[] = [];
  parts.push(`# Workspace\n\nYour working directory is: ${workspace.workspacePath}`);
  if (workspace.systemPromptAdditions) parts.push("# Workspace Context\n\n" + workspace.systemPromptAdditions);
  if (workspace.skillsPrompt) parts.push(workspace.skillsPrompt);
  if (workspace.memory) parts.push("# Memory\n\n" + workspace.memory);

  return parts.join("\n\n---\n\n");
}

export async function buildAgentSystemPrompt(config: AgentConfig): Promise<string> {
  const ctx = await loadWorkspaceContext(getAgentWorkspacePath(config), {
    builtinSkillsPath: getBuiltinSkillsPath(),
  });
  return buildSystemPrompt(ctx);
}

export async function ensureWorkspaceStructure(workspacePath: string): Promise<void> {
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(path.join(workspacePath, "memory"), { recursive: true });
}

// Stat-based identity cache: skip re-reads when (dev, ino, size, mtime) match.
const fileCache = new Map<string, { content: string; identity: string }>();

async function readFileIfExists(filePath: string): Promise<string | null> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    fileCache.delete(filePath);
    return null;
  }
  const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const cached = fileCache.get(filePath);
  if (cached && cached.identity === identity) return cached.content;

  try {
    const content = await fs.readFile(filePath, "utf-8");
    fileCache.set(filePath, { content, identity });
    return content;
  } catch {
    fileCache.delete(filePath);
    return null;
  }
}
