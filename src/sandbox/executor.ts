// src/sandbox/executor.ts — Sandbox execution orchestrator
// Manages the lifecycle of sandbox containers per-agent and routes
// command execution through them.

import type { ContainerInfo, ContainerManager, ExecResult } from "./container.js";
import type { SandboxConfig, WorkspaceAccess } from "./config.js";
import { shouldSandbox } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for sandbox command execution */
export interface SandboxExecOptions {
  /** Path to the workspace directory to mount */
  workspacePath?: string;
  /** Execution timeout in milliseconds */
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Orchestrates sandbox execution for agents.
 *
 * Each agent that requires sandboxing gets its own Docker container.
 * Containers are lazily created on first execution and reused across
 * subsequent calls. The executor manages the full container lifecycle
 * and provides cleanup for graceful shutdown.
 */
export class SandboxExecutor {
  /** Active containers keyed by agent ID */
  private containers: Map<string, ContainerInfo> = new Map();

  constructor(
    private containerManager: ContainerManager,
    private defaultConfig: SandboxConfig,
  ) {}

  /**
   * Execute a command for an agent, using a sandbox container if the agent's
   * config requires it.
   *
   * @param agentId - The agent requesting execution
   * @param command - Command and arguments to execute
   * @param options - Execution options (workspace path, timeout)
   * @returns ExecResult with exit code, stdout, and stderr
   */
  async execute(
    agentId: string,
    command: string[],
    options?: SandboxExecOptions,
  ): Promise<ExecResult> {
    const container = await this.ensureContainer(agentId, options?.workspacePath);

    if (options?.timeout) {
      return this.execWithTimeout(container.id, command, options.timeout);
    }

    return this.containerManager.exec(container.id, command);
  }

  /**
   * Check whether a specific agent should be sandboxed.
   *
   * @param agentId - The agent to check
   * @param isMainAgent - Whether this is the main agent
   * @param agentConfig - Optional per-agent sandbox config override
   * @returns true if the agent should run in a sandbox
   */
  shouldExecuteInSandbox(
    _agentId: string,
    isMainAgent: boolean,
    agentConfig?: SandboxConfig,
  ): boolean {
    const config = agentConfig ?? this.defaultConfig;
    return shouldSandbox(config, isMainAgent);
  }

  /**
   * Clean up containers. If agentId is provided, only clean up that agent's
   * container. Otherwise, clean up all containers.
   *
   * @param agentId - Optional agent ID to clean up specifically
   */
  async cleanup(agentId?: string): Promise<void> {
    if (agentId) {
      await this.cleanupAgent(agentId);
    } else {
      await this.cleanupAll();
    }
  }

  /**
   * Get the container info for an agent, if one exists.
   */
  getContainer(agentId: string): ContainerInfo | undefined {
    return this.containers.get(agentId);
  }

  /**
   * Get the count of active containers.
   */
  get activeContainerCount(): number {
    return this.containers.size;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Ensure a running container exists for the given agent.
   * Creates and starts one if necessary.
   */
  private async ensureContainer(
    agentId: string,
    workspacePath?: string,
  ): Promise<ContainerInfo> {
    const existing = this.containers.get(agentId);

    if (existing) {
      // Verify the container is still running
      const info = await this.containerManager.status(existing.id);
      if (info && info.status === "running") {
        return existing;
      }

      // Container is not running — try to restart or recreate
      if (info && info.status !== "running") {
        try {
          await this.containerManager.start(existing.id);
          const updated: ContainerInfo = { ...existing, status: "running" };
          this.containers.set(agentId, updated);
          return updated;
        } catch {
          // Failed to restart — remove and recreate
          await this.safeRemove(existing.id);
        }
      }
    }

    // Create a new container
    const containerName = `isotopes-sandbox-${agentId}`;
    const workspace = workspacePath ?? "/tmp";
    const access: WorkspaceAccess = this.defaultConfig.workspaceAccess ?? "rw";

    const container = await this.containerManager.create(
      containerName,
      workspace,
      access,
    );

    await this.containerManager.start(container.id);
    const running: ContainerInfo = { ...container, status: "running" };
    this.containers.set(agentId, running);

    return running;
  }

  /**
   * Execute a command with a timeout.
   */
  private async execWithTimeout(
    containerId: string,
    command: string[],
    timeoutMs: number,
  ): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Sandbox execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.containerManager
        .exec(containerId, command)
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error as Error);
        });
    });
  }

  /**
   * Clean up a single agent's container.
   */
  private async cleanupAgent(agentId: string): Promise<void> {
    const container = this.containers.get(agentId);
    if (!container) return;

    await this.safeRemove(container.id);
    this.containers.delete(agentId);
  }

  /**
   * Clean up all containers.
   */
  private async cleanupAll(): Promise<void> {
    const entries = [...this.containers.entries()];

    await Promise.allSettled(
      entries.map(async ([agentId, container]) => {
        await this.safeRemove(container.id);
        this.containers.delete(agentId);
      }),
    );
  }

  /**
   * Safely stop and remove a container, swallowing errors.
   */
  private async safeRemove(containerId: string): Promise<void> {
    try {
      await this.containerManager.stop(containerId, 5);
    } catch {
      // Container may already be stopped
    }
    try {
      await this.containerManager.remove(containerId, true);
    } catch {
      // Container may already be removed
    }
  }
}
