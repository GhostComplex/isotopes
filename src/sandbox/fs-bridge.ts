// src/sandbox/fs-bridge.ts — Sandbox-routed filesystem bridge
//
// Tools depend on the FsLike type. node:fs/promises naturally satisfies it;
// SandboxFs is shaped to match. The choice of which implementation to use is
// made once in cli.ts based on the agent's sandbox config — tools never branch
// on host vs. sandbox.
//
// Reads pass through to the host because the workspace bind mount makes
// container writes immediately visible on the host. Writes are routed through
// `docker exec` so they land inside the container's mount view, subject to
// the OS-level mount boundary rather than purely JS path validation.

import { spawn } from "node:child_process";
import * as nodeFs from "node:fs/promises";
import { createLogger } from "../core/logger.js";
import type { SandboxExecutor } from "./executor.js";

const log = createLogger("sandbox:fs-bridge");

// ---------------------------------------------------------------------------
// FsLike
// ---------------------------------------------------------------------------

/**
 * The subset of node:fs/promises that workspace tools use.
 *
 * node:fs/promises naturally satisfies this; SandboxFs is shaped to match.
 * Tools depend only on this type, not on either concrete implementation, so
 * adding a new fs-write tool cannot accidentally bypass the sandbox — there
 * is no other write path available to a tool author.
 */
export type FsLike = Pick<
  typeof nodeFs,
  "readFile" | "writeFile" | "mkdir" | "unlink" | "rename" | "stat" | "readdir"
>;

// ---------------------------------------------------------------------------
// FsError
// ---------------------------------------------------------------------------

export type FsErrorCode = "ENOENT" | "EACCES" | "EEXIST" | "EISDIR" | "ENOTDIR" | "EUNKNOWN";

/**
 * Error class for SandboxFs operations. Mimics the shape of NodeJS.ErrnoException
 * (`.code` field) so that existing handler code paths checking `err.code === "ENOENT"`
 * keep working uniformly across host fs and sandbox fs.
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
// SandboxFs
// ---------------------------------------------------------------------------

/**
 * Sandbox-routed filesystem implementation.
 *
 * Mutations (writeFile/mkdir/unlink/rename) shell out via the agent's container
 * using `docker exec`. Reads (readFile/readdir/stat) pass through to host fs
 * directly because the bind mount makes container writes visible on the host;
 * confining reads inside the container would just add a docker-exec round-trip
 * for no security benefit (reads have no side effect to confine).
 *
 * All paths are absolute host paths. The mount strategy mounts the workspace
 * (and any allowedWorkspaces) at the same path inside the container, so no
 * translation is required.
 */
export class SandboxFs implements FsLike {
  constructor(
    private executor: SandboxExecutor,
    private agentId: string,
  ) {}

  // -------------------------------------------------------------------------
  // Reads — passthrough to host fs.
  // -------------------------------------------------------------------------

  readFile: FsLike["readFile"] = ((...args: Parameters<FsLike["readFile"]>) =>
    nodeFs.readFile(...args)) as FsLike["readFile"];

  readdir: FsLike["readdir"] = ((...args: Parameters<FsLike["readdir"]>) =>
    nodeFs.readdir(...args)) as FsLike["readdir"];

  stat: FsLike["stat"] = ((...args: Parameters<FsLike["stat"]>) =>
    nodeFs.stat(...args)) as FsLike["stat"];

  // -------------------------------------------------------------------------
  // Writes — routed through `docker exec`.
  // -------------------------------------------------------------------------

  writeFile: FsLike["writeFile"] = (async (
    file: string,
    data: unknown,
  ): Promise<void> => {
    if (typeof file !== "string") {
      throw new FsError("EUNKNOWN", "SandboxFs.writeFile only supports string paths");
    }
    const buf = toWritePayload(data);
    // Content via stdin avoids ARG_MAX and shell-quoting bugs. Pipe as Buffer
    // (no encoding) so binary data round-trips intact.
    await this.execWithStdin(["sh", "-c", `cat > ${shQuote(file)}`], buf, `writeFile ${file}`);
  }) as FsLike["writeFile"];

  mkdir: FsLike["mkdir"] = (async (
    dirPath: string,
    options?: { recursive?: boolean } | number,
  ): Promise<undefined> => {
    if (typeof dirPath !== "string") {
      throw new FsError("EUNKNOWN", "SandboxFs.mkdir only supports string paths");
    }
    const recursive = typeof options === "object" && options?.recursive === true;
    const cmd = recursive ? `mkdir -p ${shQuote(dirPath)}` : `mkdir ${shQuote(dirPath)}`;
    await this.exec(["sh", "-c", cmd], `mkdir ${dirPath}`);
    return undefined;
  }) as FsLike["mkdir"];

  unlink: FsLike["unlink"] = (async (filePath: string): Promise<void> => {
    if (typeof filePath !== "string") {
      throw new FsError("EUNKNOWN", "SandboxFs.unlink only supports string paths");
    }
    await this.exec(["sh", "-c", `rm -- ${shQuote(filePath)}`], `unlink ${filePath}`);
  }) as FsLike["unlink"];

  rename: FsLike["rename"] = (async (
    oldPath: string,
    newPath: string,
  ): Promise<void> => {
    if (typeof oldPath !== "string" || typeof newPath !== "string") {
      throw new FsError("EUNKNOWN", "SandboxFs.rename only supports string paths");
    }
    await this.exec(
      ["sh", "-c", `mv -- ${shQuote(oldPath)} ${shQuote(newPath)}`],
      `rename ${oldPath} -> ${newPath}`,
    );
  }) as FsLike["rename"];

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

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
// Payload normalisation
// ---------------------------------------------------------------------------

/**
 * Coerce a writeFile data argument into a Buffer.
 *
 * Accepts the same input shapes as node:fs/promises.writeFile:
 *   - string                       → utf8 bytes
 *   - Buffer / Uint8Array / typed array → wrapped without copy when possible
 *   - ArrayBuffer / SharedArrayBuffer → wrapped as a view
 *
 * Anything else throws EUNKNOWN rather than silently corrupting data via
 * `String(data)` or `toString("utf-8")` round-trips.
 */
function toWritePayload(data: unknown): Buffer {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (typeof SharedArrayBuffer !== "undefined" && data instanceof SharedArrayBuffer) {
    return Buffer.from(data);
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new FsError(
    "EUNKNOWN",
    `SandboxFs.writeFile: unsupported data type ${typeof data === "object" ? (data?.constructor?.name ?? "object") : typeof data}`,
  );
}

// ---------------------------------------------------------------------------
// Shell quoting
// ---------------------------------------------------------------------------

/** POSIX single-quote a string for safe inclusion in `sh -c` payloads. */
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
