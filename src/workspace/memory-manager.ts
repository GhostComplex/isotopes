// src/workspace/memory-manager.ts — Memory management for agent workspaces
// Provides a class-based API for appending to MEMORY.md and daily notes.

import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../core/logger.js";

const log = createLogger("workspace:memory");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for the MemoryManager. */
export interface MemoryManagerOptions {
  /** Whether to create .bak backups before modifying files. Default: true */
  backup?: boolean;
}

/** Result of a memory write operation. */
export interface MemoryWriteResult {
  success: boolean;
  /** Path to the file that was written */
  filePath: string;
  /** Path to the backup file, if one was created */
  backupPath?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// MemoryManager
// ---------------------------------------------------------------------------

/**
 * MemoryManager — manages MEMORY.md and daily notes for an agent workspace.
 *
 * Provides:
 * - {@link appendMemory} — append a timestamped entry to MEMORY.md
 * - {@link appendDailyNote} — append to memory/YYYY-MM-DD.md
 * - {@link readMemory} — read current MEMORY.md content
 * - {@link readDailyNote} — read a specific daily note
 * - {@link listDailyNotes} — list available daily notes
 *
 * Automatically creates the memory/ directory if needed.
 */
export class MemoryManager {
  private backup: boolean;

  constructor(
    private workspacePath: string,
    options?: MemoryManagerOptions,
  ) {
    this.backup = options?.backup ?? true;
  }

  /**
   * Append a timestamped entry to MEMORY.md.
   * Creates the file if it doesn't exist.
   */
  async appendMemory(entry: string): Promise<MemoryWriteResult> {
    const filePath = path.join(this.workspacePath, "MEMORY.md");
    const timestamp = new Date().toISOString();
    const timestamped = `- [${timestamp}] ${entry}`;

    return this.appendToFile(filePath, timestamped);
  }

  /**
   * Append a timestamped entry to today's daily note (memory/YYYY-MM-DD.md).
   * Creates the file and memory/ directory if they don't exist.
   */
  async appendDailyNote(entry: string): Promise<MemoryWriteResult> {
    const memoryDir = path.join(this.workspacePath, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const filePath = path.join(memoryDir, `${today}.md`);
    const timestamp = new Date().toISOString().split("T")[1].replace("Z", ""); // HH:MM:SS.sss
    const timestamped = `- [${timestamp}] ${entry}`;

    return this.appendToFile(filePath, timestamped);
  }

  /**
   * Read the current contents of MEMORY.md.
   * Returns null if the file doesn't exist.
   */
  async readMemory(): Promise<string | null> {
    try {
      return await fs.readFile(
        path.join(this.workspacePath, "MEMORY.md"),
        "utf-8",
      );
    } catch {
      return null;
    }
  }

  /**
   * Read a specific daily note.
   * @param date — Date string in YYYY-MM-DD format, or a Date object.
   * Returns null if the file doesn't exist.
   */
  async readDailyNote(date: string | Date): Promise<string | null> {
    const dateStr = date instanceof Date
      ? date.toISOString().split("T")[0]
      : date;

    try {
      return await fs.readFile(
        path.join(this.workspacePath, "memory", `${dateStr}.md`),
        "utf-8",
      );
    } catch {
      return null;
    }
  }

  /**
   * List available daily notes (filenames only, e.g. ["2026-04-10.md", "2026-04-11.md"]).
   * Returns empty array if memory/ directory doesn't exist.
   */
  async listDailyNotes(): Promise<string[]> {
    try {
      const entries = await fs.readdir(
        path.join(this.workspacePath, "memory"),
      );
      return entries
        .filter((e) => /^\d{4}-\d{2}-\d{2}\.md$/.test(e))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Ensure the memory/ directory exists within the workspace.
   */
  async ensureMemoryDir(): Promise<void> {
    await fs.mkdir(path.join(this.workspacePath, "memory"), { recursive: true });
  }

  /**
   * Get the workspace path this manager is configured for.
   */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async appendToFile(
    filePath: string,
    content: string,
  ): Promise<MemoryWriteResult> {
    try {
      let existing = "";
      let fileExists = false;

      try {
        existing = await fs.readFile(filePath, "utf-8");
        fileExists = true;
      } catch {
        // File doesn't exist — will create
      }

      // Create backup if file exists and backup is enabled
      let backupPath: string | undefined;
      if (fileExists && this.backup) {
        backupPath = `${filePath}.bak`;
        await fs.copyFile(filePath, backupPath);
        log.debug(`Created backup: ${backupPath}`);
      }

      // Append with newline separator
      const newContent = existing
        ? `${existing}\n${content}`
        : content;

      await fs.writeFile(filePath, newContent, "utf-8");
      log.info(`Appended to ${path.basename(filePath)}`);

      return {
        success: true,
        filePath,
        backupPath,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Failed to append to ${filePath}:`, err);
      return {
        success: false,
        filePath,
        error: errorMessage,
      };
    }
  }
}
