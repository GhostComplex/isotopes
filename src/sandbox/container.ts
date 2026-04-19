// src/sandbox/container.ts — Docker container lifecycle management
// Wraps Docker CLI commands for creating, starting, stopping, and executing
// commands in sandbox containers.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DockerConfig, WorkspaceAccess } from "./config.js";

const execFileAsync = promisify(execFile);

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
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
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
    allowedWorkspaces: string[] = [],
  ): Promise<ContainerInfo> {
    const args = this.buildCreateArgs(name, workspacePath, access, allowedWorkspaces);

    const { stdout } = await execFileAsync("docker", args);
    const containerId = stdout.trim();

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
    await execFileAsync("docker", ["start", containerId]);
  }

  /**
   * Stop a running container.
   *
   * @param containerId - Container to stop
   * @param timeout - Seconds to wait before killing (default: 10)
   */
  async stop(containerId: string, timeout = 10): Promise<void> {
    await execFileAsync("docker", ["stop", "-t", String(timeout), containerId]);
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

    await execFileAsync("docker", args);
  }

  /**
   * Execute a command inside a running container.
   *
   * @param containerId - Container to execute in
   * @param command - Command and arguments
   * @returns ExecResult with exit code, stdout, and stderr
   */
  async exec(containerId: string, command: string[]): Promise<ExecResult> {
    try {
      const argv = this.buildExecArgv(containerId, command);
      const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1));

      return { exitCode: 0, stdout, stderr };
    } catch (error: unknown) {
      // execFile throws on non-zero exit codes
      if (isExecError(error)) {
        return {
          exitCode: error.code ?? 1,
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? "",
        };
      }
      throw error;
    }
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
      const { stdout } = await execFileAsync("docker", [
        "inspect",
        "--format",
        '{{.Id}}\t{{.Name}}\t{{.State.Status}}\t{{.Config.Image}}\t{{.Created}}',
        containerId,
      ]);

      const line = stdout.trim();
      if (!line) return null;

      return parseInspectLine(line);
    } catch {
      // Container doesn't exist
      return null;
    }
  }

  /**
   * List containers, optionally filtered by name prefix.
   */
  async list(filter?: { name?: string }): Promise<ContainerInfo[]> {
    const args = [
      "ps",
      "-a",
      "--no-trunc",
      "--format",
      '{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.CreatedAt}}',
    ];

    if (filter?.name) {
      args.push("--filter", `name=${filter.name}`);
    }

    const { stdout } = await execFileAsync("docker", args);
    const lines = stdout.trim().split("\n").filter(Boolean);

    return lines.map(parseListLine);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Build the `docker create` argument list.
   */
  private buildCreateArgs(
    name: string,
    workspacePath: string,
    access: WorkspaceAccess,
    allowedWorkspaces: string[],
  ): string[] {
    const args: string[] = ["create", "--name", name, "--init"];

    // Workspace volume mount — mounted at the same host path inside the
    // container so that absolute paths from the host resolve identically
    // (no /workspace ↔ host path translation needed in the fs bridge).
    const mountSuffix = access === "ro" ? ":ro" : "";
    args.push("-v", `${workspacePath}:${workspacePath}${mountSuffix}`);
    args.push("-w", workspacePath);

    // Additional read-only workspace mounts (parity with allowedWorkspaces
    // file-tool access).
    for (const ws of allowedWorkspaces) {
      if (ws === workspacePath) continue;
      args.push("-v", `${ws}:${ws}:ro`);
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

interface ExecFileError {
  code?: number;
  stdout?: string;
  stderr?: string;
}

function isExecError(error: unknown): error is ExecFileError {
  return typeof error === "object" && error !== null && "code" in error;
}

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
 * Parse a line from `docker ps --format`.
 * Format: ID\tNames\tStatus\tImage\tCreatedAt
 */
function parseListLine(line: string): ContainerInfo {
  const [id, name, rawStatus, image, createdStr] = line.split("\t");

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
