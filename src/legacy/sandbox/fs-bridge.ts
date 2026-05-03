// src/sandbox/fs-bridge.ts — Filesystem bridge used by SDK FS tools (read/write/edit/ls).
//
// `FsBridge` is the narrow interface those tools actually need. We provide two
// implementations:
//   - `HostFs`     — wraps node:fs/promises (default).
//   - `SandboxFs`  — reads pass through to host fs (workspace bind mount makes
//                    container writes visible on host); writes go through
//                    `docker exec` so they land inside the container's mount view.
//
// The bridge has its own shape rather than mimicking node:fs because its only
// consumer (createFsTools) needs exactly the surface below. A nodeFs-shaped
// bridge would force every method to be re-translated at the consumer.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createLogger } from "../../logging/logger.js";
import type { SandboxExecutor } from "./executor.js";

const log = createLogger("sandbox:fs-bridge");

// ---------------------------------------------------------------------------
// FsError
// ---------------------------------------------------------------------------

export type FsErrorCode = "ENOENT" | "EACCES" | "EEXIST" | "EISDIR" | "ENOTDIR" | "EUNKNOWN";

/**
 * Mimics NodeJS.ErrnoException's `.code` field so handlers checking
 * `err.code === "ENOENT"` keep working uniformly across host and sandbox.
 */
export class FsError extends Error {
  constructor(public code: FsErrorCode, message: string) {
    super(message);
    this.name = "FsError";
  }
}

/** Map a docker-exec stderr blob to a coarse fs error code. */
export function mapStderrToCode(stderr: string): FsErrorCode {
  const s = stderr.toLowerCase();
  if (s.includes("no such file") || s.includes("not found")) return "ENOENT";
  if (s.includes("permission denied")) return "EACCES";
  if (s.includes("file exists")) return "EEXIST";
  if (s.includes("is a directory")) return "EISDIR";
  if (s.includes("not a directory")) return "ENOTDIR";
  return "EUNKNOWN";
}

// ---------------------------------------------------------------------------
// FsBridge — narrow interface used by SDK FS tool factories.
// ---------------------------------------------------------------------------

export interface FsBridge {
  readFile(absolutePath: string): Promise<Buffer>;
  writeFile(absolutePath: string, content: string): Promise<void>;
  mkdir(absolutePath: string): Promise<void>;
  stat(absolutePath: string): Promise<{ isDirectory(): boolean }>;
  readdir(absolutePath: string): Promise<string[]>;
  exists(absolutePath: string): Promise<boolean>;
  access(absolutePath: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// HostFs — node:fs-backed bridge.
// ---------------------------------------------------------------------------

export class HostFs implements FsBridge {
  readFile(p: string): Promise<Buffer> {
    return fs.readFile(p);
  }
  async writeFile(p: string, content: string): Promise<void> {
    await fs.writeFile(p, content, "utf-8");
  }
  async mkdir(p: string): Promise<void> {
    await fs.mkdir(p, { recursive: true });
  }
  stat(p: string): Promise<{ isDirectory(): boolean }> {
    return fs.stat(p);
  }
  readdir(p: string): Promise<string[]> {
    return fs.readdir(p);
  }
  async exists(p: string): Promise<boolean> {
    try { await fs.stat(p); return true; } catch { return false; }
  }
  access(p: string): Promise<void> {
    return fs.access(p);
  }
}

// ---------------------------------------------------------------------------
// SandboxFs — docker-exec-routed bridge.
// ---------------------------------------------------------------------------

/**
 * Mutations (writeFile/mkdir) shell out via the agent's container using
 * `docker exec`. Reads pass through to host fs directly because the bind
 * mount makes container writes visible on the host; confining reads inside
 * the container would just add a docker-exec round-trip for no security
 * benefit (reads have no side effect to confine).
 *
 * All paths are absolute host paths. The mount strategy mounts the workspace
 * (and any allowedWorkspaces) at the same path inside the container, so no
 * translation is required.
 */
export class SandboxFs implements FsBridge {
  constructor(
    private executor: SandboxExecutor,
    private agentId: string,
  ) {}

  // Reads — passthrough.

  readFile(p: string): Promise<Buffer> {
    return fs.readFile(p);
  }
  readdir(p: string): Promise<string[]> {
    return fs.readdir(p);
  }
  stat(p: string): Promise<{ isDirectory(): boolean }> {
    return fs.stat(p);
  }
  async exists(p: string): Promise<boolean> {
    try { await fs.stat(p); return true; } catch { return false; }
  }
  access(p: string): Promise<void> {
    return fs.access(p);
  }

  // Writes — routed through `docker exec`.

  async writeFile(p: string, content: string): Promise<void> {
    await this.execWithStdin(["sh", "-c", `cat > ${shQuote(p)}`], Buffer.from(content, "utf8"), `writeFile ${p}`);
  }

  async mkdir(p: string): Promise<void> {
    await this.exec(["sh", "-c", `mkdir -p ${shQuote(p)}`], `mkdir ${p}`);
  }

  // Internals.

  private async exec(command: string[], opLabel: string): Promise<void> {
    const result = await this.executor.execute(this.agentId, command);
    if (result.exitCode !== 0) {
      const code = mapStderrToCode(result.stderr);
      log.debug(`Sandbox fs op failed`, { op: opLabel, exitCode: result.exitCode, code, stderr: result.stderr });
      throw new FsError(code, `${opLabel}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }
  }

  private async execWithStdin(command: string[], stdin: Buffer, opLabel: string): Promise<void> {
    const argv = await this.executor.buildExecArgv(this.agentId, command);
    const [bin, ...rest] = argv;

    return new Promise<void>((resolve, reject) => {
      const child = spawn(bin, rest, { stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          const mapped = mapStderrToCode(stderr);
          log.debug(`Sandbox fs op failed`, { op: opLabel, exitCode: code, code: mapped, stderr });
          reject(new FsError(mapped, `${opLabel}: ${stderr.trim() || `exit ${code}`}`));
        }
      });
      child.stdin?.end(stdin);
    });
  }
}

// ---------------------------------------------------------------------------
// Shell quoting
// ---------------------------------------------------------------------------

/** POSIX single-quote a string for safe inclusion in `sh -c` payloads. */
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
