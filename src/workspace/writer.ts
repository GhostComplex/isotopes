// src/workspace/writer.ts — Workspace file write API for self-iteration
// Allows agents to write workspace files with path validation and backup.

import fsp from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../core/logger.js";
import { globToRegExp } from "./watcher.js";

const log = createLogger("writer");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for workspace file writes. */
export interface WorkspaceWriteOptions {
  /** Path to the workspace directory */
  workspacePath: string;
  /** Allowed file patterns. Default: SOUL.md, AGENTS.md, TOOLS.md, MEMORY.md, memory/*.md */
  allowedFiles?: string[];
  /** Create .bak backup before overwrite. Default: true */
  backup?: boolean;
}

/** Result of a write operation. */
export interface WriteResult {
  success: boolean;
  backupPath?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Default allowed patterns
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWED_FILES = [
  "SOUL.md",
  "AGENTS.md",
  "TOOLS.md",
  "MEMORY.md",
  "memory/*.md",
];

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Validate that a filename is safe (no path traversal, no absolute paths).
 * @throws Error if path is unsafe
 */
export function validatePath(filename: string): void {
  // Reject absolute paths
  if (path.isAbsolute(filename)) {
    throw new Error(`Absolute paths are not allowed: ${filename}`);
  }

  // Normalize to detect traversal
  const normalized = path.normalize(filename);

  // Reject .. traversal
  if (normalized.startsWith("..") || normalized.includes(`${path.sep}..`) || normalized.includes("/../")) {
    throw new Error(`Path traversal not allowed: ${filename}`);
  }

  // Also check for .. in the original filename (catches ../foo even before normalization)
  if (filename.includes("..")) {
    throw new Error(`Path traversal not allowed: ${filename}`);
  }
}

/**
 * Check if a filename matches any of the allowed patterns.
 * 
 * Pattern matching rules:
 * - Patterns without `/` (e.g., "SOUL.md") match only files in the root directory
 * - Patterns with `/` (e.g., "memory/*.md") match against the full path
 * - `*` matches any characters except path separators
 * - `**` matches any characters including path separators (recursive)
 */
export function isAllowedFile(filename: string, allowedPatterns: string[]): boolean {
  const normalized = path.normalize(filename);

  return allowedPatterns.some((pattern) => {
    // If pattern has path separators, match against full normalized path
    if (pattern.includes("/")) {
      return globToRegExp(pattern).test(normalized);
    }
    // Pattern without '/' should only match files in root (no path separators)
    // e.g., "SOUL.md" matches "SOUL.md" but not "other/SOUL.md"
    if (normalized.includes("/") || normalized.includes(path.sep)) {
      return false;
    }
    return globToRegExp(pattern).test(normalized);
  });
}

// ---------------------------------------------------------------------------
// Core write functions
// ---------------------------------------------------------------------------

/**
 * Write content to a workspace file.
 *
 * Security:
 * - Validates filename has no path traversal (../)
 * - Validates file matches allowedFiles patterns
 * - Creates backup before overwriting existing files
 *
 * @param filename - Relative path within workspace (e.g., "SOUL.md" or "memory/2024-01-15.md")
 * @param content - Content to write
 * @param options - Write options
 */
export async function writeWorkspaceFile(
  filename: string,
  content: string,
  options: WorkspaceWriteOptions,
): Promise<WriteResult> {
  try {
    // Validate path safety
    validatePath(filename);

    // Check if file is allowed
    const allowedPatterns = options.allowedFiles ?? DEFAULT_ALLOWED_FILES;
    if (!isAllowedFile(filename, allowedPatterns)) {
      return {
        success: false,
        error: `File not in allowed list: ${filename}. Allowed patterns: ${allowedPatterns.join(", ")}`,
      };
    }

    const fullPath = path.join(options.workspacePath, filename);
    const shouldBackup = options.backup ?? true;
    let backupPath: string | undefined;

    // Check if file exists (for backup)
    let fileExists = false;
    try {
      await fsp.stat(fullPath);
      fileExists = true;
    } catch {
      // File doesn't exist, no backup needed
    }

    // Create backup if file exists and backup is enabled
    if (fileExists && shouldBackup) {
      backupPath = `${fullPath}.bak`;
      await fsp.copyFile(fullPath, backupPath);
      log.debug(`Created backup: ${backupPath}`);
    }

    // Ensure parent directory exists
    const parentDir = path.dirname(fullPath);
    await fsp.mkdir(parentDir, { recursive: true });

    // Write the file
    await fsp.writeFile(fullPath, content, "utf-8");
    log.info(`Wrote workspace file: ${filename}`);

    return {
      success: true,
      backupPath,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error(`Failed to write workspace file ${filename}:`, err);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Append content to MEMORY.md.
 * Creates the file if it doesn't exist.
 */
export async function appendToMemory(
  content: string,
  options: WorkspaceWriteOptions,
): Promise<WriteResult> {
  try {
    const filename = "MEMORY.md";

    // Validate the file is allowed
    const allowedPatterns = options.allowedFiles ?? DEFAULT_ALLOWED_FILES;
    if (!isAllowedFile(filename, allowedPatterns)) {
      return {
        success: false,
        error: `File not in allowed list: ${filename}`,
      };
    }

    const fullPath = path.join(options.workspacePath, filename);
    const shouldBackup = options.backup ?? true;
    let backupPath: string | undefined;

    // Check if file exists
    let existingContent = "";
    let fileExists = false;
    try {
      existingContent = await fsp.readFile(fullPath, "utf-8");
      fileExists = true;
    } catch {
      // File doesn't exist
    }

    // Create backup if file exists and backup is enabled
    if (fileExists && shouldBackup) {
      backupPath = `${fullPath}.bak`;
      await fsp.copyFile(fullPath, backupPath);
      log.debug(`Created backup: ${backupPath}`);
    }

    // Append content (with newline separator if file has content)
    const newContent = existingContent
      ? `${existingContent}\n${content}`
      : content;

    await fsp.writeFile(fullPath, newContent, "utf-8");
    log.info(`Appended to MEMORY.md`);

    return {
      success: true,
      backupPath,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error(`Failed to append to MEMORY.md:`, err);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Append content to today's daily note (memory/YYYY-MM-DD.md).
 * Creates the file and memory/ directory if they don't exist.
 */
export async function appendToDailyNote(
  content: string,
  options: WorkspaceWriteOptions,
): Promise<WriteResult> {
  try {
    // Generate today's date filename
    const today = new Date();
    const dateStr = today.toISOString().split("T")[0]; // YYYY-MM-DD
    const filename = `memory/${dateStr}.md`;

    // Validate the file is allowed
    const allowedPatterns = options.allowedFiles ?? DEFAULT_ALLOWED_FILES;
    if (!isAllowedFile(filename, allowedPatterns)) {
      return {
        success: false,
        error: `File not in allowed list: ${filename}`,
      };
    }

    const fullPath = path.join(options.workspacePath, filename);
    const shouldBackup = options.backup ?? true;
    let backupPath: string | undefined;

    // Ensure memory directory exists
    const memoryDir = path.join(options.workspacePath, "memory");
    await fsp.mkdir(memoryDir, { recursive: true });

    // Check if file exists
    let existingContent = "";
    let fileExists = false;
    try {
      existingContent = await fsp.readFile(fullPath, "utf-8");
      fileExists = true;
    } catch {
      // File doesn't exist
    }

    // Create backup if file exists and backup is enabled
    if (fileExists && shouldBackup) {
      backupPath = `${fullPath}.bak`;
      await fsp.copyFile(fullPath, backupPath);
      log.debug(`Created backup: ${backupPath}`);
    }

    // Append content (with newline separator if file has content)
    const newContent = existingContent
      ? `${existingContent}\n${content}`
      : content;

    await fsp.writeFile(fullPath, newContent, "utf-8");
    log.info(`Appended to daily note: ${filename}`);

    return {
      success: true,
      backupPath,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error(`Failed to append to daily note:`, err);
    return {
      success: false,
      error: errorMessage,
    };
  }
}
