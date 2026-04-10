// src/tools/self-iteration.ts — Self-iteration tools for agents
// Enables agents to update their own workspace files and create skills.

import path from "node:path";
import fsp from "node:fs/promises";
import type { Tool } from "../core/types.js";
import type { ToolHandler, ToolEntry } from "../core/tools.js";
import {
  writeWorkspaceFile,
  appendToMemory,
  appendToDailyNote,
  type WorkspaceWriteOptions,
} from "../workspace/writer.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("tools:self-iteration");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for self-iteration tools. */
export interface SelfIterationConfig {
  /** Path to the agent's workspace directory */
  workspacePath: string;
  /** Allowed file patterns for iteration. Default includes workspace files and skills */
  allowedFiles?: string[];
  /** Whether to create backups before overwriting. Default: true */
  backup?: boolean;
}

/** Arguments for the iterate_self tool. */
interface IterateSelfArgs {
  file: string;
  action: "replace" | "append" | "patch" | "delete";
  content?: string;
}

/** Arguments for the create_skill tool. */
interface CreateSkillArgs {
  name: string;
  description: string;
  content: string;
}

/** Arguments for the append_memory tool. */
interface AppendMemoryArgs {
  content: string;
  target?: "memory" | "daily";
}

// ---------------------------------------------------------------------------
// Default allowed files for self-iteration
// ---------------------------------------------------------------------------

const DEFAULT_SELF_ITERATION_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "AGENTS.md",
  "TOOLS.md",
  "MEMORY.md",
  "BOOTSTRAP.md",
  "memory/*.md",
  "skills/**/*.md",
  "skills/**/*.yaml",
  "skills/**/*.yml",
];

// ---------------------------------------------------------------------------
// iterate_self tool
// ---------------------------------------------------------------------------

const ITERATE_SELF_TOOL: Tool = {
  name: "iterate_self",
  description: `Update your own workspace files (SOUL.md, AGENTS.md, TOOLS.md, IDENTITY.md, MEMORY.md, or skills).

Use this tool when you:
- Learn something worth encoding into your configuration
- Want to update your personality or behavior guidelines (SOUL.md)
- Need to add new tools documentation (TOOLS.md)
- Want to update your operating instructions (AGENTS.md)
- Need to complete the hatch ritual by deleting BOOTSTRAP.md

Actions:
- "replace": Replace the entire file content
- "append": Add content to the end of the file
- "delete": Delete a file (only BOOTSTRAP.md can be deleted)
- "patch": Apply a diff-style patch (not yet implemented, use replace for now)

A backup (.bak) is created before any changes.`,
  parameters: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "Workspace file to update (e.g., 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'skills/my-skill/SKILL.md')",
      },
      action: {
        type: "string",
        enum: ["replace", "append", "patch", "delete"],
        description: "How to apply the change. 'delete' removes the file (only BOOTSTRAP.md).",
      },
      content: {
        type: "string",
        description: "New content (for replace/append) or patch (for patch). Not required for delete.",
      },
    },
    required: ["file", "action"],
  },
};

function createIterateSelfHandler(config: SelfIterationConfig): ToolHandler {
  return async (rawArgs: unknown): Promise<string> => {
    const args = rawArgs as IterateSelfArgs;
    const { file, action, content } = args;

    log.info(`iterate_self: ${action} on ${file}`);

    if (action === "delete") {
      // Only allow deleting BOOTSTRAP.md for safety
      if (file !== "BOOTSTRAP.md") {
        return JSON.stringify({
          success: false,
          error: "Only BOOTSTRAP.md can be deleted via iterate_self.",
        });
      }
      const fullPath = path.join(config.workspacePath, file);
      try {
        await fsp.unlink(fullPath);
        log.info("BOOTSTRAP.md deleted — hatch complete");
        return JSON.stringify({
          success: true,
          message: "BOOTSTRAP.md deleted. Hatch complete — you're you now.",
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ success: false, error: errorMessage });
      }
    }

    if (action === "patch") {
      return JSON.stringify({
        success: false,
        error: "Patch action not yet implemented. Use 'replace' or 'append' instead.",
      });
    }

    // Content is required for replace/append actions
    if (!content) {
      return JSON.stringify({
        success: false,
        error: `Content is required for '${action}' action.`,
      });
    }

    const options: WorkspaceWriteOptions = {
      workspacePath: config.workspacePath,
      allowedFiles: config.allowedFiles ?? DEFAULT_SELF_ITERATION_FILES,
      backup: config.backup ?? true,
    };

    if (action === "append") {
      // For append, read existing content first
      const fullPath = path.join(config.workspacePath, file);
      let existingContent = "";
      try {
        existingContent = await fsp.readFile(fullPath, "utf-8");
      } catch {
        // File doesn't exist, will create new
      }
      const newContent = existingContent ? `${existingContent}\n${content}` : content;
      const result = await writeWorkspaceFile(file, newContent, options);
      return JSON.stringify(result);
    }

    // Replace action
    const result = await writeWorkspaceFile(file, content, options);
    return JSON.stringify(result);
  };
}

// ---------------------------------------------------------------------------
// create_skill tool
// ---------------------------------------------------------------------------

const CREATE_SKILL_TOOL: Tool = {
  name: "create_skill",
  description: `Create a new skill in your workspace skills directory.

Skills are self-contained instruction sets that extend your capabilities.
Each skill gets its own directory under skills/{name}/ with a SKILL.md file.

The skill name should be:
- lowercase with hyphens (e.g., "git-helper", "code-review")
- descriptive of the skill's purpose

The content should include YAML frontmatter with at least:
---
name: skill-name
description: Short description for skill matching
---

Followed by the skill instructions in markdown.`,
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Skill name (lowercase, hyphenated, e.g., 'git-helper')",
      },
      description: {
        type: "string",
        description: "Short description for skill matching (used in skill discovery)",
      },
      content: {
        type: "string",
        description: "Full SKILL.md content (should include YAML frontmatter)",
      },
    },
    required: ["name", "description", "content"],
  },
};

function createCreateSkillHandler(config: SelfIterationConfig): ToolHandler {
  return async (rawArgs: unknown): Promise<string> => {
    const args = rawArgs as CreateSkillArgs;
    const { name, content } = args;

    log.info(`create_skill: ${name}`);

    // Validate skill name pattern
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      return JSON.stringify({
        success: false,
        error: `Invalid skill name: "${name}". Must be lowercase, start with a letter, and use hyphens only.`,
      });
    }

    // Validate content has frontmatter
    if (!content.startsWith("---")) {
      return JSON.stringify({
        success: false,
        error: "Skill content must start with YAML frontmatter (---)",
      });
    }

    // Create skill directory and SKILL.md
    const skillDir = path.join(config.workspacePath, "skills", name);
    const skillPath = `skills/${name}/SKILL.md`;

    try {
      // Create directory
      await fsp.mkdir(skillDir, { recursive: true });

      // Write SKILL.md
      const options: WorkspaceWriteOptions = {
        workspacePath: config.workspacePath,
        allowedFiles: config.allowedFiles ?? DEFAULT_SELF_ITERATION_FILES,
        backup: config.backup ?? true,
      };

      const result = await writeWorkspaceFile(skillPath, content, options);

      if (result.success) {
        return JSON.stringify({
          success: true,
          path: skillPath,
          message: `Created skill "${name}" at ${skillPath}. It will be available after workspace reload.`,
        });
      }

      return JSON.stringify(result);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Failed to create skill ${name}:`, err);
      return JSON.stringify({
        success: false,
        error: errorMessage,
      });
    }
  };
}

// ---------------------------------------------------------------------------
// append_memory tool
// ---------------------------------------------------------------------------

const APPEND_MEMORY_TOOL: Tool = {
  name: "append_memory",
  description: `Append content to MEMORY.md or today's daily note.

Use this to record:
- Important events or decisions
- Lessons learned
- Things to remember for future sessions
- Daily notes and observations

Target options:
- "memory": Append to MEMORY.md (long-term memory)
- "daily": Append to memory/YYYY-MM-DD.md (today's daily note)`,
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "Content to append",
      },
      target: {
        type: "string",
        enum: ["memory", "daily"],
        description: "Where to append: 'memory' for MEMORY.md, 'daily' for today's note. Default: daily",
      },
    },
    required: ["content"],
  },
};

function createAppendMemoryHandler(config: SelfIterationConfig): ToolHandler {
  return async (rawArgs: unknown): Promise<string> => {
    const args = rawArgs as AppendMemoryArgs;
    const { content, target = "daily" } = args;

    log.info(`append_memory: ${target}`);

    const options: WorkspaceWriteOptions = {
      workspacePath: config.workspacePath,
      allowedFiles: config.allowedFiles ?? DEFAULT_SELF_ITERATION_FILES,
      backup: config.backup ?? true,
    };

    if (target === "memory") {
      const result = await appendToMemory(content, options);
      return JSON.stringify(result);
    }

    // Daily note
    const result = await appendToDailyNote(content, options);
    return JSON.stringify(result);
  };
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create self-iteration tools for an agent.
 *
 * Returns tools that allow the agent to:
 * - Update workspace files (SOUL.md, TOOLS.md, etc.)
 * - Create new skills
 * - Append to memory files
 *
 * @param config - Self-iteration configuration
 * @returns Array of tool entries to register
 */
export function createSelfIterationTools(config: SelfIterationConfig): ToolEntry[] {
  return [
    {
      tool: ITERATE_SELF_TOOL,
      handler: createIterateSelfHandler(config),
    },
    {
      tool: CREATE_SKILL_TOOL,
      handler: createCreateSkillHandler(config),
    },
    {
      tool: APPEND_MEMORY_TOOL,
      handler: createAppendMemoryHandler(config),
    },
  ];
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  ITERATE_SELF_TOOL,
  CREATE_SKILL_TOOL,
  APPEND_MEMORY_TOOL,
  DEFAULT_SELF_ITERATION_FILES,
};
