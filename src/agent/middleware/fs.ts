// FsBridge — narrow interface for SDK FS tools (read/write/edit/ls).
// HostFs (node:fs) for non-sandbox; SandboxFs (all ops via docker exec) for sandbox.

import fs from "node:fs/promises";
import type { ExecResult, SandboxExecutor } from "./executor.js";

export type FsErrorCode = "ENOENT" | "EACCES" | "EEXIST" | "EISDIR" | "ENOTDIR" | "EUNKNOWN";

/** Mimics NodeJS.ErrnoException's `.code` so `err.code === "ENOENT"` works uniformly. */
export class FsError extends Error {
  constructor(public code: FsErrorCode, message: string) {
    super(message);
    this.name = "FsError";
  }
}

/** Map a stderr blob to a coarse fs error code. */
export function mapStderrToCode(stderr: string): FsErrorCode {
  const s = stderr.toLowerCase();
  if (s.includes("no such file") || s.includes("not found")) return "ENOENT";
  if (s.includes("permission denied")) return "EACCES";
  if (s.includes("file exists")) return "EEXIST";
  if (s.includes("is a directory")) return "EISDIR";
  if (s.includes("not a directory")) return "ENOTDIR";
  return "EUNKNOWN";
}

export interface FsBridge {
  readFile(absolutePath: string): Promise<Buffer>;
  writeFile(absolutePath: string, content: string): Promise<void>;
  mkdir(absolutePath: string): Promise<void>;
  stat(absolutePath: string): Promise<{ isDirectory(): boolean }>;
  readdir(absolutePath: string): Promise<string[]>;
  exists(absolutePath: string): Promise<boolean>;
  access(absolutePath: string): Promise<void>;
}

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

/** All operations route through `docker exec`; containment is the container's mount view. */
export class SandboxFs implements FsBridge {
  constructor(
    private executor: SandboxExecutor,
    private agentId: string,
  ) {}

  async readFile(p: string): Promise<Buffer> {
    const r = await this.executor.execute(this.agentId, ["cat", p]);
    throwIfFailed(r, `readFile ${p}`);
    return r.stdout;
  }

  async writeFile(p: string, content: string): Promise<void> {
    const r = await this.executor.execute(
      this.agentId,
      ["sh", "-c", `cat > ${shQuote(p)}`],
      { stdin: content },
    );
    throwIfFailed(r, `writeFile ${p}`);
  }

  async mkdir(p: string): Promise<void> {
    const r = await this.executor.execute(this.agentId, ["sh", "-c", `mkdir -p ${shQuote(p)}`]);
    throwIfFailed(r, `mkdir ${p}`);
  }

  async stat(p: string): Promise<{ isDirectory(): boolean }> {
    // %F prints "regular file" / "directory" / "symbolic link" / etc.
    const r = await this.executor.execute(this.agentId, ["stat", "-c", "%F", p]);
    throwIfFailed(r, `stat ${p}`);
    const fileType = r.stdout.toString("utf8").trim();
    return { isDirectory: () => fileType === "directory" };
  }

  async readdir(p: string): Promise<string[]> {
    // -1A: one per line, include dotfiles, exclude . and ..
    const r = await this.executor.execute(this.agentId, ["ls", "-1A", p]);
    throwIfFailed(r, `readdir ${p}`);
    return r.stdout.toString("utf8").split("\n").filter(Boolean);
  }

  async exists(p: string): Promise<boolean> {
    const r = await this.executor.execute(this.agentId, ["test", "-e", p]);
    return r.exitCode === 0;
  }

  async access(p: string): Promise<void> {
    const r = await this.executor.execute(this.agentId, ["test", "-r", p]);
    if (r.exitCode !== 0) throw new FsError("EACCES", `access ${p}: not readable`);
  }
}

function throwIfFailed(r: ExecResult, opLabel: string): void {
  if (r.exitCode === 0) return;
  const stderrText = r.stderr.toString("utf8");
  throw new FsError(mapStderrToCode(stderrText), `${opLabel}: ${stderrText.trim() || `exit ${r.exitCode}`}`);
}

/** POSIX single-quote a string for safe inclusion in `sh -c` payloads. */
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
