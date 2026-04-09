// src/daemon/log-rotation.ts — Log rotation for daemon output
// Rotates log files when they exceed a configured size, with optional gzip.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { createLogger } from "../core/logger.js";

const log = createLogger("daemon:log-rotation");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for log file rotation. */
export interface LogRotationConfig {
  /** Maximum file size in bytes before rotation triggers. */
  maxSize: number;
  /** Number of rotated files to keep (e.g., 5 → .1 … .5). */
  maxFiles: number;
  /** Compress rotated files with gzip (default true). */
  compress?: boolean;
}

// ---------------------------------------------------------------------------
// LogRotator
// ---------------------------------------------------------------------------

/**
 * LogRotator — rotates daemon log files when they exceed a configured size.
 *
 * Supports numbered rotation slots (`.1` through `.N`) and optional gzip
 * compression. Oldest files are deleted to stay within {@link LogRotationConfig.maxFiles}.
 */
export class LogRotator {
  private config: Required<LogRotationConfig>;

  constructor(
    private logPath: string,
    config: LogRotationConfig,
  ) {
    this.config = {
      maxSize: config.maxSize,
      maxFiles: config.maxFiles,
      compress: config.compress ?? true,
    };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Check whether the current log file exceeds `maxSize`.
   */
  async shouldRotate(): Promise<boolean> {
    try {
      const stat = await fs.stat(this.logPath);
      return stat.size >= this.config.maxSize;
    } catch {
      // File doesn't exist – nothing to rotate
      return false;
    }
  }

  /**
   * Rotate the current log file.
   *
   * Rotation chain:
   *   log.5.gz → deleted
   *   log.4.gz → log.5.gz
   *   …
   *   log.1.gz → log.2.gz
   *   log      → log.1.gz  (or log.1 when compress=false)
   */
  async rotate(): Promise<void> {
    if (!(await this.shouldRotate())) {
      return;
    }

    log.info(`Rotating ${this.logPath}`);
    const ext = this.config.compress ? ".gz" : "";

    // Shift existing rotated files up by one index
    for (let i = this.config.maxFiles; i >= 1; i--) {
      const src = this.rotatedPath(i - 1, ext);
      const dst = this.rotatedPath(i, ext);

      if (i === this.config.maxFiles) {
        // Oldest slot – delete to make room
        await this.tryUnlink(dst);
      }

      // i-1 == 0 is the special "about to be rotated" slot handled below
      if (i - 1 >= 1) {
        await this.tryRename(src, dst);
      }
    }

    // Move current log → slot 1
    const slot1 = this.rotatedPath(1, ext);
    if (this.config.compress) {
      await this.compressFile(this.logPath, slot1);
      await this.tryUnlink(this.logPath);
    } else {
      await this.tryRename(this.logPath, slot1);
    }

    // Create a fresh (empty) log file so writers don't error
    await fs.writeFile(this.logPath, "", "utf-8");

    log.info("Rotation complete");
  }

  /**
   * Delete rotated files that exceed `maxFiles`.
   */
  async cleanup(): Promise<void> {
    const ext = this.config.compress ? ".gz" : "";
    for (let i = this.config.maxFiles + 1; i <= this.config.maxFiles + 10; i++) {
      const p = this.rotatedPath(i, ext);
      if (await this.exists(p)) {
        await this.tryUnlink(p);
        log.info(`Cleaned up ${p}`);
      } else {
        break; // no more files beyond this index
      }
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private rotatedPath(index: number, ext: string): string {
    return `${this.logPath}.${index}${ext}`;
  }

  private async tryRename(src: string, dst: string): Promise<void> {
    try {
      await fs.rename(src, dst);
    } catch {
      // source may not exist
    }
  }

  private async tryUnlink(p: string): Promise<void> {
    try {
      await fs.unlink(p);
    } catch {
      // already gone
    }
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async compressFile(src: string, dst: string): Promise<void> {
    const input = fsSync.createReadStream(src);
    const output = fsSync.createWriteStream(dst);
    const gzip = createGzip();

    await pipeline(input, gzip, output);
  }
}
