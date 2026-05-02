// src/agent/workspace.ts — Workspace file loading and management
// Handles SOUL.md, MEMORY.md, TOOLS.md, and other workspace files.

import fs from "node:fs/promises";
import path from "node:path";
import { loadSkills, formatSkillsForPrompt } from "@mariozechner/pi-coding-agent";
import { getIsotopesHome, resolveAgentWorkspacePath, resolveBuiltinSkillsDir } from "../paths.js";
import type { AgentConfig } from "./types.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("skills");

const ASSISTANT_OUTPUT_DIRECTIVES = `# Assistant Output Directives

When you reply on a chat surface, you may include the following inline tags
in your message to request delivery metadata. Tags are stripped from the
user-visible text and are only honored on channels that support the
underlying feature; channels without support silently ignore them.

- \`[[reply_to_current]]\` — render this message as a native reply to the
  message that triggered the current turn. Prefer this form.
- \`[[reply_to: <message-id>]]\` — render this message as a native reply to
  a specific message id. Use only when the id was explicitly given to you
  (by the user or by a tool result).

Place the tag at the start of your response, before any other text.
Whitespace inside the brackets is allowed. Tags are channel-agnostic — each
transport (Discord, etc.) renders them in the platform's native
reply / quote primitive where available.`;

/** Standard workspace files that contribute to system prompt */
export const WORKSPACE_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "AGENTS.md",
  "BOOTSTRAP.md",
] as const;

/** Memory files loaded for context */
export const MEMORY_FILES = [
  "MEMORY.md",
] as const;

export interface WorkspaceContext {
  /** Combined content from workspace files (SOUL.md, USER.md, etc.) */
  systemPromptAdditions: string;
  /** Content from MEMORY.md if present */
  memory: string | null;
  /** Path to the workspace directory */
  workspacePath: string;
  /** Skills prompt block (XML format) */
  skillsPrompt: string;
}

/** Load workspace files (SOUL/MEMORY/etc) + skills into a context object. */
export async function loadWorkspaceContext(workspacePath: string, options?: { builtinSkillsPath?: string }): Promise<WorkspaceContext> {
  const additions: string[] = [];

  for (const filename of WORKSPACE_FILES) {
    const content = await readFileIfExists(path.join(workspacePath, filename));
    if (content) {
      additions.push(`## ${filename}\n\n${content}`);
    }
  }

  let memory: string | null = null;
  const memoryPath = path.join(workspacePath, "MEMORY.md");
  memory = await readFileIfExists(memoryPath);

  // Yesterday's daily memory
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
  const yesterdayMemoryPath = path.join(workspacePath, "memory", `${yesterday}.md`);
  const yesterdayMemory = await readFileIfExists(yesterdayMemoryPath);
  if (yesterdayMemory) {
    memory = memory ? `${memory}\n\n## Yesterday's Notes\n\n${yesterdayMemory}` : `## Yesterday's Notes\n\n${yesterdayMemory}`;
  }

  // Today's daily memory
  const today = new Date().toISOString().split("T")[0];
  const dailyMemoryPath = path.join(workspacePath, "memory", `${today}.md`);
  const dailyMemory = await readFileIfExists(dailyMemoryPath);
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

/** Build a complete system prompt from a loaded workspace context. */
export function buildSystemPrompt(workspace: WorkspaceContext | null): string {
  if (!workspace) {
    return ASSISTANT_OUTPUT_DIRECTIVES;
  }

  const parts: string[] = [];
  parts.push(`# Workspace\n\nYour working directory is: ${workspace.workspacePath}`);
  if (workspace.systemPromptAdditions) parts.push("# Workspace Context\n\n" + workspace.systemPromptAdditions);
  if (workspace.skillsPrompt) parts.push(workspace.skillsPrompt);
  if (workspace.memory) parts.push("# Memory\n\n" + workspace.memory);
  parts.push(ASSISTANT_OUTPUT_DIRECTIVES);

  return parts.join("\n\n---\n\n");
}

/** End-to-end: resolve agent's workspace path, load context, build prompt. */
export async function buildAgentSystemPrompt(config: AgentConfig): Promise<string> {
  const ctx = await loadWorkspaceContext(resolveAgentWorkspacePath(config), {
    builtinSkillsPath: resolveBuiltinSkillsDir(),
  });
  return buildSystemPrompt(ctx);
}

/** Ensure workspace + memory subdir exist. */
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
