// src/workspace/templates.ts — Workspace template seeding
// Seeds default files into new agent workspaces using write-exclusive mode.

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../../logging/logger.js";

const log = createLogger("workspace:templates");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A workspace template file definition. */
export interface WorkspaceTemplate {
  /** Filename relative to workspace root */
  filename: string;
  /** Default file content */
  content: string;
  /** Only seed if workspace is brand-new (no existing files) */
  firstRunOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Template loading
// ---------------------------------------------------------------------------

const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "template-files");

const templateCache = new Map<string, string>();

function loadTemplate(filename: string): string {
  let content = templateCache.get(filename);
  if (content === undefined) {
    content = readFileSync(path.join(TEMPLATE_DIR, filename), "utf-8");
    templateCache.set(filename, content);
  }
  return content;
}

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

/** File names that indicate a workspace has been previously configured. */
const EXISTING_CONTENT_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "AGENTS.md",
  "MEMORY.md",
  "BOOTSTRAP.md",
  "HEARTBEAT.md",
];

/** Get the workspace templates for an agent. Subagent gets a focused
 * "ephemeral helper" SOUL; everyone else gets the full personal-assistant set. */
export function getWorkspaceTemplates(agentId?: string): WorkspaceTemplate[] {
  const isSubagent = agentId === "subagent";
  return [
    { filename: "SOUL.md", content: loadTemplate(isSubagent ? "SOUL.subagent.md" : "SOUL.md") },
    { filename: "IDENTITY.md", content: loadTemplate("IDENTITY.md") },
    { filename: "USER.md", content: loadTemplate("USER.md") },
    { filename: "TOOLS.md", content: loadTemplate("TOOLS.md") },
    { filename: "AGENTS.md", content: loadTemplate("AGENTS.md") },
    { filename: "HEARTBEAT.md", content: loadTemplate("HEARTBEAT.md") },
    { filename: "BOOTSTRAP.md", content: loadTemplate("BOOTSTRAP.md"), firstRunOnly: true },
  ];
}

/**
 * Check if a workspace directory has any existing content files.
 * Returns false for brand-new (empty) workspaces.
 */
export async function isBrandNewWorkspace(workspacePath: string): Promise<boolean> {
  for (const filename of EXISTING_CONTENT_FILES) {
    try {
      await fs.access(path.join(workspacePath, filename));
      return false; // File exists — not brand new
    } catch {
      // File doesn't exist, continue checking
    }
  }

  // Also check for memory files or git history
  try {
    const memoryDir = path.join(workspacePath, "memory");
    const entries = await fs.readdir(memoryDir);
    if (entries.some((e) => e.endsWith(".md"))) {
      return false;
    }
  } catch {
    // memory dir doesn't exist or empty
  }

  return true;
}

/**
 * Seed template files into a workspace directory.
 *
 * Uses `fs.writeFile` with `{ flag: 'wx' }` (write-exclusive) so existing
 * files are never overwritten. Returns the list of files that were created.
 *
 * `BOOTSTRAP.md` is only seeded for brand-new workspaces (no existing content).
 *
 * @param workspacePath — Absolute path to the agent's workspace directory.
 */
export async function seedWorkspaceTemplates(
  workspacePath: string,
  agentId?: string,
): Promise<string[]> {
  const templates = getWorkspaceTemplates(agentId);
  const brandNew = await isBrandNewWorkspace(workspacePath);
  const created: string[] = [];

  for (const template of templates) {
    // Skip first-run-only templates if workspace already has content
    if (template.firstRunOnly && !brandNew) {
      continue;
    }

    const filePath = path.join(workspacePath, template.filename);

    try {
      await fs.writeFile(filePath, template.content, { flag: "wx" });
      created.push(template.filename);
      log.debug(`Seeded template: ${template.filename}`);
    } catch (err) {
      // EEXIST is expected — file already exists, skip silently
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        log.error(`Failed to seed template ${template.filename}:`, err);
      }
    }
  }

  if (created.length > 0) {
    log.info(`Seeded ${created.length} template(s) in ${workspacePath}: ${created.join(", ")}`);
  }

  return created;
}
