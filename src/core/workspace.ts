// src/core/workspace.ts — Workspace file loading and management
// Handles SOUL.md, MEMORY.md, TOOLS.md, and other workspace files.

import fs from "node:fs/promises";
import path from "node:path";
import { SkillLoader } from "../skills/index.js";

/** Standard workspace files that contribute to system prompt */
export const WORKSPACE_FILES = [
  "SOUL.md",
  "USER.md",
  "TOOLS.md",
  "AGENTS.md",
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

/**
 * Load workspace context from a directory.
 * Reads standard workspace files and combines them for use in system prompt.
 */
export async function loadWorkspaceContext(workspacePath: string): Promise<WorkspaceContext> {
  const additions: string[] = [];

  // Load standard workspace files
  for (const filename of WORKSPACE_FILES) {
    const content = await readFileIfExists(path.join(workspacePath, filename));
    if (content) {
      additions.push(`## ${filename}\n\n${content}`);
    }
  }

  // Load memory file
  let memory: string | null = null;
  const memoryPath = path.join(workspacePath, "MEMORY.md");
  memory = await readFileIfExists(memoryPath);

  // Load today's daily memory if exists
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const dailyMemoryPath = path.join(workspacePath, "memory", `${today}.md`);
  const dailyMemory = await readFileIfExists(dailyMemoryPath);
  if (dailyMemory) {
    memory = memory ? `${memory}\n\n## Today's Notes\n\n${dailyMemory}` : dailyMemory;
  }

  // Load skills from workspace
  const skillLoader = new SkillLoader({ workspacePath });
  const skillsPrompt = await skillLoader.generatePrompt();

  return {
    systemPromptAdditions: additions.join("\n\n"),
    memory,
    workspacePath,
    skillsPrompt,
  };
}

/**
 * Build a complete system prompt by combining base prompt with workspace context.
 */
export function buildSystemPrompt(
  basePrompt: string,
  workspace: WorkspaceContext | null,
): string {
  if (!workspace) {
    return basePrompt;
  }

  const parts = [basePrompt];

  if (workspace.systemPromptAdditions) {
    parts.push("# Workspace Context\n\n" + workspace.systemPromptAdditions);
  }

  if (workspace.skillsPrompt) {
    parts.push(workspace.skillsPrompt);
  }

  if (workspace.memory) {
    parts.push("# Memory\n\n" + workspace.memory);
  }

  return parts.join("\n\n---\n\n");
}

/**
 * Get the sessions directory for a workspace.
 */
export function getSessionsDir(workspacePath: string): string {
  return path.join(workspacePath, "sessions");
}

/**
 * Ensure workspace directory structure exists.
 */
export async function ensureWorkspaceStructure(workspacePath: string): Promise<void> {
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(path.join(workspacePath, "sessions"), { recursive: true });
  await fs.mkdir(path.join(workspacePath, "memory"), { recursive: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}
