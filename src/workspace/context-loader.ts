// src/workspace/context-loader.ts — Class-based workspace context loader
// Loads and caches workspace context files, supports refresh for hot-reload.

import path from "node:path";
import fs from "node:fs/promises";
import { createLogger } from "../core/logger.js";
import { SkillLoader } from "../skills/index.js";
import { resolveBundledSkillsDir } from "../skills/bundled-dir.js";

const log = createLogger("workspace:context-loader");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Standard workspace files that contribute to system prompt. */
export const CONTEXT_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "AGENTS.md",
  "BOOTSTRAP.md",
] as const;

/** Memory-related files loaded separately. */
export const MEMORY_FILES = [
  "MEMORY.md",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Loaded workspace context ready for system prompt injection. */
export interface LoadedContext {
  /** Combined content from workspace files (SOUL.md, USER.md, etc.) */
  systemPromptAdditions: string;
  /** Content from MEMORY.md (+ today's daily note) if present */
  memory: string | null;
  /** Skills prompt block (XML format) */
  skillsPrompt: string;
  /** Workspace directory path */
  workspacePath: string;
  /** Individual file contents, keyed by filename */
  files: Map<string, string>;
  /** When the context was last loaded */
  loadedAt: Date;
}

// ---------------------------------------------------------------------------
// WorkspaceContextLoader
// ---------------------------------------------------------------------------

/**
 * WorkspaceContextLoader — loads and caches workspace context files.
 *
 * Reads standard workspace files (SOUL.md, MEMORY.md, IDENTITY.md, etc.)
 * on startup and provides a combined context string for system prompt
 * injection. Call {@link refresh} to re-read files from disk (hot-reload).
 */
export class WorkspaceContextLoader {
  private context: LoadedContext | null = null;

  constructor(private workspacePath: string) {}

  /**
   * Load workspace context from disk.
   * Reads all standard files and caches the result.
   * Safe to call multiple times — subsequent calls refresh the cache.
   */
  async load(): Promise<LoadedContext> {
    const files = new Map<string, string>();
    const additions: string[] = [];

    // Load standard workspace files
    for (const filename of CONTEXT_FILES) {
      const content = await this.readFileIfExists(filename);
      if (content !== null) {
        files.set(filename, content);
        additions.push(`## ${filename}\n\n${content}`);
      }
    }

    // Load MEMORY.md
    let memory: string | null = null;
    const memoryContent = await this.readFileIfExists("MEMORY.md");
    if (memoryContent !== null) {
      files.set("MEMORY.md", memoryContent);
      memory = memoryContent;
    }

    // Load today's daily note if it exists
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const dailyFilename = `memory/${today}.md`;
    const dailyContent = await this.readFileIfExists(dailyFilename);
    if (dailyContent !== null) {
      files.set(dailyFilename, dailyContent);
      memory = memory
        ? `${memory}\n\n## Today's Notes\n\n${dailyContent}`
        : dailyContent;
    }

    // Load skills
    const skillLoader = new SkillLoader({ workspacePath: this.workspacePath, bundledPath: resolveBundledSkillsDir() });
    const skillsPrompt = await skillLoader.generatePrompt();

    this.context = {
      systemPromptAdditions: additions.join("\n\n"),
      memory,
      skillsPrompt,
      workspacePath: this.workspacePath,
      files,
      loadedAt: new Date(),
    };

    log.info(`Loaded workspace context (${files.size} file(s)) from ${this.workspacePath}`);
    return this.context;
  }

  /**
   * Refresh context by re-reading all files from disk.
   * Alias for {@link load} — provided for hot-reload semantics.
   */
  async refresh(): Promise<LoadedContext> {
    log.debug(`Refreshing workspace context for ${this.workspacePath}`);
    return this.load();
  }

  /**
   * Get the cached context. Returns null if {@link load} hasn't been called.
   */
  getContext(): LoadedContext | null {
    return this.context;
  }

  /**
   * Get a specific file's content from the cache.
   * Returns null if the file wasn't found during the last load.
   */
  getFile(filename: string): string | null {
    return this.context?.files.get(filename) ?? null;
  }

  /**
   * Build a complete system prompt by combining a base prompt with the loaded context.
   * Returns the base prompt unchanged if context hasn't been loaded.
   */
  buildSystemPrompt(basePrompt: string): string {
    if (!this.context) {
      return basePrompt;
    }

    const parts = [basePrompt];

    parts.push(`# Workspace\n\nYour working directory is: ${this.context.workspacePath}`);

    if (this.context.systemPromptAdditions) {
      parts.push("# Workspace Context\n\n" + this.context.systemPromptAdditions);
    }

    if (this.context.skillsPrompt) {
      parts.push(this.context.skillsPrompt);
    }

    if (this.context.memory) {
      parts.push("# Memory\n\n" + this.context.memory);
    }

    return parts.join("\n\n---\n\n");
  }

  /**
   * Get the workspace path this loader is configured for.
   */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async readFileIfExists(filename: string): Promise<string | null> {
    try {
      return await fs.readFile(
        path.join(this.workspacePath, filename),
        "utf-8",
      );
    } catch {
      return null;
    }
  }
}
