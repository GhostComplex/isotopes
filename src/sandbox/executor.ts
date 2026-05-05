// src/sandbox/executor.ts — Per-agent container lifecycle + command routing.

import { createLogger } from "../logging/logger.js";
import type { ContainerInfo, ContainerManager, ExecResult } from "./container.js";
import { shouldSandbox, type SandboxConfig, type WorkspaceAccess } from "./config.js";

const log = createLogger("sandbox:executor");

export interface SandboxExecOptions {
  workspacePath?: string;
  timeout?: number;
  stdin?: Buffer | string;
}

/**
 * Lazily creates one container per agent and routes commands through it.
 */
export class SandboxExecutor {
  private containers: Map<string, ContainerInfo> = new Map();

  constructor(
    private containerManager: ContainerManager,
    private defaultConfig: SandboxConfig,
  ) {}

  async execute(
    agentId: string,
    command: string[],
    options?: SandboxExecOptions,
  ): Promise<ExecResult> {
    const container = await this.ensureContainer(agentId, options?.workspacePath);
    const execOpts = options?.stdin !== undefined ? { stdin: options.stdin } : undefined;
    if (options?.timeout) {
      return this.execWithTimeout(container.id, command, options.timeout, execOpts);
    }
    return this.containerManager.exec(container.id, command, execOpts);
  }

  /**
   * Host-side argv that runs `command` inside the agent's container via
   * `docker exec`. Used for background processes — caller spawns this argv
   * directly so it can track ChildProcess and signal it (docker forwards
   * SIGTERM via --sig-proxy=true).
   */
  async buildExecArgv(
    agentId: string,
    command: string[],
    options?: SandboxExecOptions,
  ): Promise<string[]> {
    const container = await this.ensureContainer(agentId, options?.workspacePath);
    return this.containerManager.buildExecArgv(container.id, command);
  }

  shouldExecuteInSandbox(_agentId: string, agentConfig?: SandboxConfig): boolean {
    return shouldSandbox(agentConfig ?? this.defaultConfig);
  }

  async cleanup(agentId?: string): Promise<void> {
    if (agentId) await this.cleanupAgent(agentId);
    else await this.cleanupAll();
  }

  private async ensureContainer(
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
    const access: WorkspaceAccess = this.defaultConfig.workspaceAccess ?? "rw";

    const container = await this.containerManager.create(
      containerName,
      workspace,
      access,
      this.defaultConfig.mounts ?? [],
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
    if (!container) return;
    await this.safeRemove(container.id);
    this.containers.delete(agentId);
  }

  private async cleanupAll(): Promise<void> {
    const entries = [...this.containers.entries()];
    await Promise.allSettled(
      entries.map(async ([agentId, container]) => {
        await this.safeRemove(container.id);
        this.containers.delete(agentId);
      }),
    );
  }

  private async safeRemove(containerId: string): Promise<void> {
    try { await this.containerManager.stop(containerId, 5); }
    catch (err) { log.debug(`Stop failed for ${containerId}`, err); }
    try { await this.containerManager.remove(containerId, true); }
    catch (err) { log.debug(`Remove failed for ${containerId}`, err); }
  }
}
