import { spawn } from "node:child_process";
import { createLogger } from "../logging/logger.js";
import type { DockerConfig, Mount, WorkspaceAccess } from "./config.js";

const log = createLogger("sandbox:container");

/** Cap collected stdout/stderr per `exec()` call to prevent OOM from runaway commands. */
const EXEC_MAX_OUTPUT_BYTES = 1024 * 1024;

export type ContainerStatus = "created" | "running" | "paused" | "exited";

export interface ContainerInfo {
  id: string;
  name: string;
  status: ContainerStatus;
  image: string;
  createdAt: Date;
}

export interface ExecResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  /** True iff stdout or stderr was capped at EXEC_MAX_OUTPUT_BYTES. */
  truncated?: boolean;
}

/** Wraps the `docker` CLI rather than the API to avoid heavy SDK deps. */
export class ContainerManager {
  constructor(private config: DockerConfig) {}

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

  async start(containerId: string): Promise<void> {
    await this.runDocker(["start", containerId]);
  }

  async stop(containerId: string, timeout = 10): Promise<void> {
    await this.runDocker(["stop", "-t", String(timeout), containerId]);
  }

  async remove(containerId: string, force = false): Promise<void> {
    const args = ["rm"];
    if (force) args.push("--force");
    args.push(containerId);
    await this.runDocker(args);
  }

  /** Does not throw on non-zero exit — caller inspects exitCode. */
  async exec(
    containerId: string,
    command: string[],
    options?: { stdin?: Buffer | string },
  ): Promise<ExecResult> {
    return this.runDockerWithCapture(["exec", "-i", containerId, ...command], options);
  }

  /** Returns argv (not a spawned process) so callers can manage their own ChildProcess for long-running tasks. */
  buildExecArgv(containerId: string, command: string[]): string[] {
    return ["docker", "exec", "-i", containerId, ...command];
  }

  /** Returns null when the container doesn't exist (or docker can't be reached — see debug log). */
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
    } catch (err) {
      log.debug(`status(${containerId}) failed`, err);
      return null;
    }
  }

  /** Run `docker <args>`; capture all output, never throws on exit code. */
  private runDockerWithCapture(args: string[], options?: { stdin?: Buffer | string }): Promise<ExecResult> {
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

  /** Like runDockerWithCapture, but throws on non-zero exit. Used by lifecycle commands. */
  private async runDocker(args: string[]): Promise<ExecResult> {
    const result = await this.runDockerWithCapture(args);
    if (result.exitCode !== 0) {
      throw new Error(`docker ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.toString("utf8").trim()}`);
    }
    return result;
  }

  private buildCreateArgs(
    name: string,
    workspacePath: string,
    access: WorkspaceAccess,
    mounts: Mount[],
  ): string[] {
    const args: string[] = ["create", "--name", name, "--init"];

    // Mount workspace at the same host path so absolute paths resolve
    // identically inside and outside — fs bridge needs no translation.
    const workspaceSuffix = access === "ro" ? ":ro" : "";
    args.push("-v", `${workspacePath}:${workspacePath}${workspaceSuffix}`);
    args.push("-w", workspacePath);

    for (const m of mounts) {
      if (m.host === workspacePath) continue;  // dedupe with workspace mount
      const suffix = m.readOnly ? ":ro" : "";
      args.push("-v", `${m.host}:${m.container}${suffix}`);
    }

    if (this.config.network) {
      args.push("--network", this.config.network);
    }
    if (this.config.extraHosts) {
      for (const host of this.config.extraHosts) args.push("--add-host", host);
    }
    if (this.config.cpuLimit !== undefined) {
      args.push("--cpus", String(this.config.cpuLimit));
    }
    if (this.config.memoryLimit) {
      args.push("--memory", this.config.memoryLimit);
    }
    if (this.config.pidsLimit !== undefined && this.config.pidsLimit > 0) {
      args.push("--pids-limit", String(this.config.pidsLimit));
    }
    if (this.config.noNewPrivileges !== false) {
      args.push("--security-opt", "no-new-privileges");
    }

    args.push(this.config.image);
    args.push("tail", "-f", "/dev/null");  // keep container alive
    return args;
  }
}

function parseInspectLine(line: string): ContainerInfo {
  const [id, rawName, rawStatus, image, createdStr] = line.split("\t");
  const name = rawName.startsWith("/") ? rawName.slice(1) : rawName;  // docker prefixes names with /
  return {
    id,
    name,
    status: normalizeStatus(rawStatus),
    image,
    createdAt: new Date(createdStr),
  };
}

/** Docker status strings: "Up 2 minutes", "Exited (0) 5 minutes ago", "created", "paused", etc. */
function normalizeStatus(raw: string): ContainerStatus {
  const lower = raw.toLowerCase();
  if (lower === "created") return "created";
  if (lower === "paused" || lower.includes("paused")) return "paused";
  if (lower === "running" || lower.startsWith("up")) return "running";
  return "exited";
}
