import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface WorkspaceTemplate {
  filename: string;
  content: string;
  /** Only seed if workspace is brand-new (no existing files) */
  firstRunOnly?: boolean;
}

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

export function getWorkspaceTemplates(agentId?: string): WorkspaceTemplate[] {
  if (agentId === "subagent") {
    return [{ filename: "AGENTS.md", content: loadTemplate("AGENTS.subagent.md") }];
  }
  return [
    { filename: "SOUL.md", content: loadTemplate("SOUL.md") },
    { filename: "IDENTITY.md", content: loadTemplate("IDENTITY.md") },
    { filename: "USER.md", content: loadTemplate("USER.md") },
    { filename: "TOOLS.md", content: loadTemplate("TOOLS.md") },
    { filename: "AGENTS.md", content: loadTemplate("AGENTS.md") },
    { filename: "HEARTBEAT.md", content: loadTemplate("HEARTBEAT.md") },
    { filename: "BOOTSTRAP.md", content: loadTemplate("BOOTSTRAP.md"), firstRunOnly: true },
  ];
}

export async function isBrandNewWorkspace(workspacePath: string): Promise<boolean> {
  for (const filename of EXISTING_CONTENT_FILES) {
    try {
      await fs.access(path.join(workspacePath, filename));
      return false;
    } catch { /* not found */ }
  }

  try {
    const entries = await fs.readdir(path.join(workspacePath, "memory"));
    if (entries.some((e) => e.endsWith(".md"))) return false;
  } catch { /* not found */ }

  return true;
}

/** Uses `wx` flag so existing files are never overwritten. */
export async function seedWorkspaceTemplates(
  workspacePath: string,
  agentId?: string,
): Promise<string[]> {
  const templates = getWorkspaceTemplates(agentId);
  const brandNew = await isBrandNewWorkspace(workspacePath);
  const created: string[] = [];

  for (const template of templates) {
    if (template.firstRunOnly && !brandNew) continue;

    try {
      await fs.writeFile(path.join(workspacePath, template.filename), template.content, { flag: "wx" });
      created.push(template.filename);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  return created;
}
