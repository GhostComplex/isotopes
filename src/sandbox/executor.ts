// src/sandbox/executor.ts — Per-agent container lifecycle + command routing.

import { createLogger } from "../logging/logger.js";
import { ContainerManager, type ContainerInfo } from "./container.js";
import type { Executor, ExecOptions, ExecResult } from "../agent/executor.js";
import { type DockerConfig, type Mount, type SandboxConfig, type WorkspaceAccess } from "./config.js";

const log = createLogger("sandbox:executor");

/**
 * Lazily creates one container per agent and routes commands through it.
 * Use `bind(agentId)` to get a per-agent Executor for tool consumption.
 */
export class SandboxExecutor {
  private containers: Map<string, ContainerInfo> = new Map();
  private inflight: Map<string, Promise<ContainerInfo>> = new Map();
  private agentMounts: Map<string, Mount[]> = new Map();
  private agentDocker: Map<string, DockerConfig> = new Map();
  private agentWorkspaceAccess: Map<string, WorkspaceAccess> = new Map();

  constructor(private containerManager: ContainerManager) {}

  /** Returns an executor when sandbox docker config is present, else undefined. */
  static fromConfig(config: SandboxConfig): SandboxExecutor | undefined {
    if (!config.docker) return undefined;
    return new SandboxExecutor(new ContainerManager());
  }

  /** Register an agent's resolved sandbox config. Re-calling merges into existing — absent fields preserve previous values. */
  registerAgent(agentId: string, config: SandboxConfig): void {
    if (config.docker) this.agentDocker.set(agentId, config.docker);
    if (config.mounts) this.agentMounts.set(agentId, config.mounts);
    if (config.workspaceAccess) this.agentWorkspaceAccess.set(agentId, config.workspaceAccess);
  }

  /** Returns a per-agent Executor that routes through this agent's container. */
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
        } catch (err) {
          log.debug(`Failed to restart container ${existing.id}, recreating`, err);
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
      log.info(`Removing orphan container ${containerName} (${orphan.status}) from previous run`);
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
    catch (err) { log.debug(`Stop failed for ${containerId}`, err); }
    try { await this.containerManager.remove(containerId, true); }
    catch (err) { log.debug(`Remove failed for ${containerId}`, err); }
  }
}
