import { spawn } from "node:child_process";
import { ContainerManager, type ContainerInfo } from "./container.js";
import { type DockerConfig, type Mount, type SandboxConfig, type WorkspaceAccess } from "./sandbox-config.js";


/** Cap collected stdout/stderr per `execute()` call to prevent OOM from runaway commands. */
export const EXEC_MAX_OUTPUT_BYTES = 100 * 1024;

export interface ExecResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  truncated?: boolean;
}

export interface ExecOptions {
  /** Sandbox honors at container-create time, not per-call. */
  workspacePath?: string;
  timeout?: number;
  stdin?: Buffer | string;
}

export interface Executor {
  execute(argv: string[], opts?: ExecOptions): Promise<ExecResult>;

  /** Host argv to spawn — used by background-process tracking so the caller keeps the ChildProcess. SandboxExecutor prepends `docker exec -i <ctr>`. */
  buildExecArgv(argv: string[], opts?: ExecOptions): Promise<string[]>;
}

/** child_process.spawn — host = trust model, no cwd jail / env scrub. */
export class HostExecutor implements Executor {
  async execute(argv: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (argv.length === 0) {
      return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("argv is empty") };
    }

    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd: opts?.workspacePath,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;

      const collect = (chunks: Buffer[], chunk: Buffer, getBytes: () => number, setBytes: (n: number) => void, setTruncated: (b: boolean) => void): void => {
        const bytes = getBytes();
        if (bytes >= EXEC_MAX_OUTPUT_BYTES) { setTruncated(true); return; }
        if (bytes + chunk.length > EXEC_MAX_OUTPUT_BYTES) {
          chunks.push(chunk.subarray(0, EXEC_MAX_OUTPUT_BYTES - bytes));
          setBytes(EXEC_MAX_OUTPUT_BYTES);
          setTruncated(true);
        } else {
          chunks.push(chunk);
          setBytes(bytes + chunk.length);
        }
      };

      child.stdout?.on("data", (chunk: Buffer) =>
        collect(stdoutChunks, chunk, () => stdoutBytes, (n) => { stdoutBytes = n; }, (b) => { stdoutTruncated = b; }));
      child.stderr?.on("data", (chunk: Buffer) =>
        collect(stderrChunks, chunk, () => stderrBytes, (n) => { stderrBytes = n; }, (b) => { stderrTruncated = b; }));

      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      if (opts?.timeout) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          reject(new Error(`Host execution timed out after ${opts.timeout}ms`));
        }, opts.timeout);
      }

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        if (timedOut) return;  // already rejected by timer
        const truncMarker = Buffer.from(`\n[output truncated at ${EXEC_MAX_OUTPUT_BYTES} bytes]`, "utf8");
        const stdout = stdoutTruncated ? Buffer.concat([...stdoutChunks, truncMarker]) : Buffer.concat(stdoutChunks);
        const stderr = stderrTruncated ? Buffer.concat([...stderrChunks, truncMarker]) : Buffer.concat(stderrChunks);
        resolve({
          exitCode: code ?? 0,
          stdout,
          stderr,
          ...(stdoutTruncated || stderrTruncated ? { truncated: true } : {}),
        });
      });

      if (opts?.stdin !== undefined) {
        child.stdin?.end(opts.stdin);
      } else {
        child.stdin?.end();
      }
    });
  }

  async buildExecArgv(argv: string[]): Promise<string[]> {
    return argv;
  }
}

/** One container per agent, lazily created. `bind(agentId)` returns a per-agent Executor for tools. */
export class SandboxExecutor {
  private containers: Map<string, ContainerInfo> = new Map();
  private inflight: Map<string, Promise<ContainerInfo>> = new Map();
  private agentMounts: Map<string, Mount[]> = new Map();
  private agentDocker: Map<string, DockerConfig> = new Map();
  private agentWorkspaceAccess: Map<string, WorkspaceAccess> = new Map();

  constructor(private containerManager: ContainerManager) {}

  static fromConfig(config: SandboxConfig): SandboxExecutor | undefined {
    if (!config.docker) return undefined;
    return new SandboxExecutor(new ContainerManager());
  }

  /** Re-calling merges into existing — absent fields preserve previous values. */
  registerAgent(agentId: string, config: SandboxConfig): void {
    if (config.docker) this.agentDocker.set(agentId, config.docker);
    if (config.mounts) this.agentMounts.set(agentId, config.mounts);
    if (config.workspaceAccess) this.agentWorkspaceAccess.set(agentId, config.workspaceAccess);
  }

  bind(agentId: string): Executor {
    return {
      execute: (argv, opts) => this.execute(agentId, argv, opts),
      buildExecArgv: (argv, opts) => this.buildExecArgv(agentId, argv, opts),
    };
  }

  async execute(
    agentId: string,
    command: string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    const container = await this.ensureContainer(agentId, options?.workspacePath);
    const execOpts = options?.stdin !== undefined ? { stdin: options.stdin } : undefined;
    if (options?.timeout) {
      return this.execWithTimeout(container.id, command, options.timeout, execOpts);
    }
    return this.containerManager.exec(container.id, command, execOpts);
  }

  async buildExecArgv(
    agentId: string,
    command: string[],
    options?: ExecOptions,
  ): Promise<string[]> {
    const container = await this.ensureContainer(agentId, options?.workspacePath);
    return this.containerManager.buildExecArgv(container.id, command);
  }

  async cleanup(agentId?: string): Promise<void> {
    if (agentId) await this.cleanupAgent(agentId);
    else await this.cleanupAll();
  }

  private async ensureContainer(
    agentId: string,
    workspacePath?: string,
  ): Promise<ContainerInfo> {
    const pending = this.inflight.get(agentId);
    if (pending) return pending;
    const promise = this.doEnsureContainer(agentId, workspacePath);
    this.inflight.set(agentId, promise);
    try { return await promise; }
    finally { this.inflight.delete(agentId); }
  }

  private async doEnsureContainer(
    agentId: string,
    workspacePath?: string,
  ): Promise<ContainerInfo> {
    const existing = this.containers.get(agentId);

    if (existing) {
      const info = await this.containerManager.status(existing.id);
      if (info && info.status === "running") return existing;

      if (info && info.status !== "running") {
        try {
          await this.containerManager.start(existing.id);
          const updated: ContainerInfo = { ...existing, status: "running" };
          this.containers.set(agentId, updated);
          return updated;
        } catch {
          await this.safeRemove(existing.id);
        }
      }
    }

    const containerName = `isotopes-sandbox-${agentId}`;
    const workspace = workspacePath ?? "/tmp";
    const access: WorkspaceAccess = this.agentWorkspaceAccess.get(agentId) ?? "rw";

    // Reap an orphan from a previous process — otherwise `docker create` fails on the name conflict.
    const orphan = await this.containerManager.status(containerName);
    if (orphan) {
      await this.safeRemove(orphan.id);
    }

    const docker = this.agentDocker.get(agentId);
    if (!docker) {
      throw new Error(`agent "${agentId}" sandboxed but no docker config registered`);
    }

    const container = await this.containerManager.create(
      containerName,
      workspace,
      access,
      this.agentMounts.get(agentId) ?? [],
      docker,
    );

    await this.containerManager.start(container.id);
    const running: ContainerInfo = { ...container, status: "running" };
    this.containers.set(agentId, running);
    return running;
  }

  private async execWithTimeout(
    containerId: string,
    command: string[],
    timeoutMs: number,
    options?: { stdin?: Buffer | string },
  ): Promise<ExecResult> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Sandbox execution timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      return await Promise.race([this.containerManager.exec(containerId, command, options), timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private async cleanupAgent(agentId: string): Promise<void> {
    const container = this.containers.get(agentId);
    if (container) {
      await this.safeRemove(container.id);
      this.containers.delete(agentId);
    }
    this.agentMounts.delete(agentId);
    this.agentDocker.delete(agentId);
    this.agentWorkspaceAccess.delete(agentId);
  }

  private async cleanupAll(): Promise<void> {
    const entries = [...this.containers.entries()];
    await Promise.allSettled(
      entries.map(async ([agentId, container]) => {
        await this.safeRemove(container.id);
        this.containers.delete(agentId);
      }),
    );
    this.agentMounts.clear();
    this.agentDocker.clear();
    this.agentWorkspaceAccess.clear();
  }

  private async safeRemove(containerId: string): Promise<void> {
    try { await this.containerManager.stop(containerId, 5); }
    catch { /* ignore */ }
    try { await this.containerManager.remove(containerId, true); }
    catch { /* ignore */ }
  }
}
