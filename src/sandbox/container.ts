// src/sandbox/container.ts — Docker container lifecycle management
// Wraps Docker CLI commands for creating, starting, stopping, and executing
// commands in sandbox containers.

import { spawn } from "node:child_process";
import type { DockerConfig, Mount, WorkspaceAccess } from "./config.js";

/** Cap collected stdout/stderr per `exec()` call to prevent OOM from runaway commands. */
const EXEC_MAX_OUTPUT_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Container status */
export type ContainerStatus = "created" | "running" | "paused" | "exited";

/** Information about a Docker container */
export interface ContainerInfo {
  /** Docker container ID */
  id: string;
  /** Container name */
  name: string;
  /** Current status */
  status: ContainerStatus;
  /** Docker image used */
  image: string;
  /** When the container was created */
  createdAt: Date;
}

/** Result of executing a command in a container */
export interface ExecResult {
  /** Process exit code */
  exitCode: number;
  /** Standard output (raw bytes — call `.toString("utf8")` if you want a string) */
  stdout: Buffer;
  /** Standard error (raw bytes) */
  stderr: Buffer;
  /** True iff stdout or stderr was capped at EXEC_MAX_OUTPUT_BYTES. */
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Container Manager
// ---------------------------------------------------------------------------

/**
 * Manages Docker container lifecycle for sandbox execution.
 *
 * Uses the Docker CLI (`docker`) rather than the Docker API to avoid
 * heavy dependencies. All operations are async and shell out to `docker`.
 */
export class ContainerManager {
  constructor(private config: DockerConfig) {}

  /**
   * Create a new container with the workspace mounted.
   *
   * @param name - Container name (must be unique)
   * @param workspacePath - Host path to mount; mounted at the same path
   *   inside the container so absolute host paths resolve identically.
   * @param access - Mount access level (rw or ro)
   * @returns ContainerInfo for the created container
   */
  async create(
    name: string,
    workspacePath: string,
    access: WorkspaceAccess,
    mounts: Mount[] = [],
  ): Promise<ContainerInfo> {
    const args = this.buildCreateArgs(name, workspacePath, access, mounts);
    const { stdout } = await this.runDocker(args);
    const containerId = stdout.toString("utf8").trim();

    return {
      id: containerId,
      name,
      status: "created",
      image: this.config.image,
      createdAt: new Date(),
    };
  }

  /**
   * Start a stopped or created container.
   */
  async start(containerId: string): Promise<void> {
    await this.runDocker(["start", containerId]);
  }

  /**
   * Stop a running container.
   *
   * @param containerId - Container to stop
   * @param timeout - Seconds to wait before killing (default: 10)
   */
  async stop(containerId: string, timeout = 10): Promise<void> {
    await this.runDocker(["stop", "-t", String(timeout), containerId]);
  }

  /**
   * Remove a container.
   *
   * @param containerId - Container to remove
   * @param force - Force removal of running container
   */
  async remove(containerId: string, force = false): Promise<void> {
    const args = ["rm"];
    if (force) args.push("--force");
    args.push(containerId);
    await this.runDocker(args);
  }

  /**
   * Execute a command inside a running container.
   *
   * @param containerId - Container to execute in
   * @param command - Command and arguments
   * @returns ExecResult with exit code, stdout, and stderr (does not throw on non-zero)
   */
  async exec(
    containerId: string,
    command: string[],
    options?: { stdin?: Buffer | string },
  ): Promise<ExecResult> {
    return this.spawnDocker(["exec", "-i", containerId, ...command], options);
  }

  /**
   * Build the argv to run a command inside the container as a host-side
   * `docker exec` child process. Used by background-process spawning so that
   * stdin/stdout/stderr/SIGTERM all flow through the host child handle.
   */
  buildExecArgv(containerId: string, command: string[]): string[] {
    return ["docker", "exec", "-i", containerId, ...command];
  }

  /**
   * Get the current status of a container.
   *
   * @returns ContainerInfo or null if the container doesn't exist
   */
  async status(containerId: string): Promise<ContainerInfo | null> {
    try {
      const { stdout } = await this.runDocker([
        "inspect",
        "--format",
        '{{.Id}}\t{{.Name}}\t{{.State.Status}}\t{{.Config.Image}}\t{{.Created}}',
        containerId,
      ]);

      const line = stdout.toString("utf8").trim();
      if (!line) return null;

      return parseInspectLine(line);
    } catch {
      // Container doesn't exist
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Spawn `docker <args>`; resolve with collected output, never throws on exit code. */
  private spawnDocker(args: string[], options?: { stdin?: Buffer | string }): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdoutBytes >= EXEC_MAX_OUTPUT_BYTES) { stdoutTruncated = true; return; }
        if (stdoutBytes + chunk.length > EXEC_MAX_OUTPUT_BYTES) {
          stdoutChunks.push(chunk.subarray(0, EXEC_MAX_OUTPUT_BYTES - stdoutBytes));
          stdoutBytes = EXEC_MAX_OUTPUT_BYTES;
          stdoutTruncated = true;
        } else {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBytes >= EXEC_MAX_OUTPUT_BYTES) { stderrTruncated = true; return; }
        if (stderrBytes + chunk.length > EXEC_MAX_OUTPUT_BYTES) {
          stderrChunks.push(chunk.subarray(0, EXEC_MAX_OUTPUT_BYTES - stderrBytes));
          stderrBytes = EXEC_MAX_OUTPUT_BYTES;
          stderrTruncated = true;
        } else {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        }
      });
      child.on("error", reject);
      child.on("close", (code) => {
        const truncMarker = Buffer.from(`\n[output truncated at ${EXEC_MAX_OUTPUT_BYTES} bytes]`, "utf8");
        const stdout = stdoutTruncated
          ? Buffer.concat([...stdoutChunks, truncMarker])
          : Buffer.concat(stdoutChunks);
        const stderr = stderrTruncated
          ? Buffer.concat([...stderrChunks, truncMarker])
          : Buffer.concat(stderrChunks);
        resolve({
          exitCode: code ?? 0,
          stdout,
          stderr,
          ...(stdoutTruncated || stderrTruncated ? { truncated: true } : {}),
        });
      });
      child.stdin.end(options?.stdin ?? "");
    });
  }

  /** Like spawnDocker, but throws on non-zero exit. Used by lifecycle commands. */
  private async runDocker(args: string[]): Promise<ExecResult> {
    const result = await this.spawnDocker(args);
    if (result.exitCode !== 0) {
      throw new Error(`docker ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.toString("utf8").trim()}`);
    }
    return result;
  }

  /**
   * Build the `docker create` argument list.
   */
  private buildCreateArgs(
    name: string,
    workspacePath: string,
    access: WorkspaceAccess,
    mounts: Mount[],
  ): string[] {
    const args: string[] = ["create", "--name", name, "--init"];

    // Workspace volume mount — mounted at the same host path inside the
    // container so that absolute paths from the host resolve identically
    // (no /workspace ↔ host path translation needed in the fs bridge).
    const workspaceSuffix = access === "ro" ? ":ro" : "";
    args.push("-v", `${workspacePath}:${workspacePath}${workspaceSuffix}`);
    args.push("-w", workspacePath);

    // User-configured additional mounts.
    for (const m of mounts) {
      if (m.host === workspacePath) continue;  // dedupe with workspace mount
      const suffix = m.readOnly ? ":ro" : "";
      args.push("-v", `${m.host}:${m.container}${suffix}`);
    }

    // Network mode
    if (this.config.network) {
      args.push("--network", this.config.network);
    }

    // Extra hosts
    if (this.config.extraHosts) {
      for (const host of this.config.extraHosts) {
        args.push("--add-host", host);
      }
    }

    // Resource limits
    if (this.config.cpuLimit !== undefined) {
      args.push("--cpus", String(this.config.cpuLimit));
    }
    if (this.config.memoryLimit) {
      args.push("--memory", this.config.memoryLimit);
    }
    if (this.config.pidsLimit !== undefined && this.config.pidsLimit > 0) {
      args.push("--pids-limit", String(this.config.pidsLimit));
    }

    // Linux capability hardening
    if (this.config.capDrop) {
      for (const cap of this.config.capDrop) {
        args.push("--cap-drop", cap);
      }
    }
    if (this.config.capAdd) {
      for (const cap of this.config.capAdd) {
        args.push("--cap-add", cap);
      }
    }
    if (this.config.noNewPrivileges !== false) {
      args.push("--security-opt", "no-new-privileges");
    }

    // Image
    args.push(this.config.image);

    // Keep container alive with a long-running process
    args.push("tail", "-f", "/dev/null");

    return args;
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a line from `docker inspect --format`.
 * Format: ID\tName\tStatus\tImage\tCreated
 */
function parseInspectLine(line: string): ContainerInfo {
  const [id, rawName, rawStatus, image, createdStr] = line.split("\t");
  // docker inspect prefixes names with /
  const name = rawName.startsWith("/") ? rawName.slice(1) : rawName;

  return {
    id,
    name,
    status: normalizeStatus(rawStatus),
    image,
    createdAt: new Date(createdStr),
  };
}

/**
 * Normalize Docker status strings to our ContainerStatus enum.
 * Docker uses strings like "Up 2 minutes", "Exited (0) 5 minutes ago", etc.
 */
function normalizeStatus(raw: string): ContainerStatus {
  const lower = raw.toLowerCase();
  if (lower === "created") return "created";
  if (lower === "paused" || lower.includes("paused")) return "paused";
  if (lower === "running" || lower.startsWith("up")) return "running";
  // "exited", "Exited (0) ...", "dead", "removing", etc.
  return "exited";
}
