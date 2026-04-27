// src/tools/spawn-agent.ts — Spawn tool for delegating tasks to coding agents

import { createLogger } from "../core/logger.js";
import {
  AgentRuntime,
  summarizeEvents,
  type RunEvent,
} from "../agents/index.js";
import type { BuiltinOptions } from "../agents/types.js";
import type { PiMonoCore } from "../core/pi-mono.js";
import { taskRegistry } from "../agents/task-registry.js";
import { createRunRecorder } from "../agents/persistence.js";
import type { SessionStore } from "../core/types.js";
import type { ResolvedSpawningConfig } from "../core/config.js";

const log = createLogger("tools:spawn-agent");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpawnBackendConfig {
  config?: ResolvedSpawningConfig;
  core?: PiMonoCore;
}

export interface SpawnAgentOptions {
  /** Agent ID — "claude" for external CLI, or a named agent ID for in-process */
  agent?: string;
  /** Working directory for the agent (required) */
  cwd: string;
  /** Model override */
  model?: string;
  /** Timeout in seconds (default: 300) */
  timeout?: number;
  /** Maximum turns (default: 50) */
  maxTurns?: number;
  /** Current nesting depth (0 = top-level). */
  depth?: number;
  /** Allowed workspace roots for validation */
  allowedWorkspaces?: string[];
  /** Callback for streaming events */
  onEvent?: (event: RunEvent) => void;
  /** Session ID for task registry tracking */
  sessionId?: string;
  /** Channel ID for task registry tracking */
  channelId?: string;
  /** Thread ID where agent streams output (for /stop support) */
  threadId?: string;
  /** Parent agent id, used as the owner of the persisted session. */
  parentAgentId?: string;
  /**
   * Real agentId to record this run under. Named agents pass their own
   * id (e.g. `code-reviewer`); anonymous/dynamic agents leave this
   * unset and the recorder falls back to `parentAgentId`.
   */
  targetAgentId?: string;
  /** Builtin runner payload. Required when agent is not an external runner. */
  builtin?: BuiltinOptions;
}

export interface SpawnAgentResult {
  success: boolean;
  output?: string;
  error?: string;
  exitCode: number;
  eventCount: number;
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

let sharedBackend: AgentRuntime | undefined;
let backendConfig: SpawnBackendConfig = {};
let spawnStoreFactory: ((agentId: string) => Promise<SessionStore | undefined> | SessionStore | undefined) | undefined;

/**
 * Register a factory that resolves the SessionStore for a spawned agent's
 * runs. Called once per spawn with the resolved `targetAgentId`.
 */
export function setSpawnSessionStoreFactory(
  factory: ((agentId: string) => Promise<SessionStore | undefined> | SessionStore | undefined) | undefined,
): void {
  spawnStoreFactory = factory;
}

/**
 * Initialize the spawn backend with configuration.
 * Should be called during app startup with config from `spawning`.
 */
export function initSpawnBackend(config: SpawnBackendConfig): void {
  backendConfig = config;
  sharedBackend = undefined;
  log.info("Spawn backend initialized", {
    claudePermissionMode: config.config?.claude.permissionMode,
  });
}

function getBackend(allowedWorkspaces?: string[]): AgentRuntime {
  const key = allowedWorkspaces?.sort().join(":") ?? "";
  if (sharedBackend && sharedBackend.workspacesKey === key) {
    return sharedBackend;
  }
  if (sharedBackend && sharedBackend.activeCount > 0) {
    log.warn("Replacing AgentRuntime with in-flight runs; cancelling them", {
      activeCount: sharedBackend.activeCount,
      oldKey: sharedBackend.workspacesKey,
      newKey: key,
    });
    sharedBackend.cancelAll();
  }
  sharedBackend = new AgentRuntime({
    allowedWorkspaceRoots: allowedWorkspaces,
    config: backendConfig.config,
    core: backendConfig.core,
  });
  return sharedBackend;
}

let taskCounter = 0;

/**
 * Get the shared AgentRuntime instance for use by other modules.
 * Returns undefined if the backend hasn't been initialized.
 */
export function getSpawnBackend(allowedWorkspaces?: string[]): AgentRuntime | undefined {
  if (!backendConfig.config) {
    return undefined;
  }
  return getBackend(allowedWorkspaces);
}

/**
 * Get the list of agent IDs that can be spawned.
 */
export function getSupportedAgents(): string[] {
  const backend = getBackend();
  return backend.getExternalRunnerIds();
}

/**
 * Spawn an agent to execute a task.
 */
export async function spawnAgent(
  prompt: string,
  options: SpawnAgentOptions,
): Promise<SpawnAgentResult> {
  const agentId = options.agent ?? "claude";
  const taskId = `spawn-${++taskCounter}-${Date.now()}`;

  log.info("Spawning agent", { taskId, agentId, cwd: options.cwd });

  const backend = getBackend(options.allowedWorkspaces);

  taskRegistry.register(taskId, options.sessionId ?? "", options.channelId ?? "", prompt);

  if (options.threadId) {
    taskRegistry.setThreadId(taskId, options.threadId);
  }

  const parentAgentId = options.parentAgentId ?? "unknown";
  const targetAgentId = options.targetAgentId ?? parentAgentId;
  const store = spawnStoreFactory ? await spawnStoreFactory(targetAgentId) : undefined;

  const recorder = await createRunRecorder({
    store,
    targetAgentId,
    parentAgentId,
    parentSessionId: options.sessionId,
    taskId,
    backend: agentId,
    cwd: options.cwd,
    prompt,
    channelId: options.channelId,
    threadId: options.threadId,
  });

  const startedAt = Date.now();

  try {
    const events = backend.spawn(taskId, {
      agentId,
      prompt,
      cwd: options.cwd,
      model: options.model,
      timeout: options.timeout,
      maxTurns: options.maxTurns ?? 50,
      depth: options.depth,
      maxDepth: backendConfig.config?.maxDepth,
      ...(options.builtin ? { builtin: options.builtin } : {}),
    });

    const collected: RunEvent[] = [];
    for await (const event of events) {
      collected.push(event);
      options.onEvent?.(event);
      await recorder.record(event);
    }

    const result = summarizeEvents(collected);

    log.info("Agent completed", {
      taskId,
      success: result.success,
      exitCode: result.exitCode,
    });

    await recorder.patchMetadata({
      exitCode: result.exitCode,
      costUsd: collected.find((e): e is Extract<RunEvent, { type: "run:done" }> => e.type === "run:done" && "costUsd" in e)?.costUsd,
      durationMs: Date.now() - startedAt,
      ...(result.error ? { error: result.error } : {}),
    });

    taskRegistry.unregister(taskId);

    return {
      success: result.success,
      output: result.output,
      error: result.error,
      exitCode: result.exitCode,
      eventCount: collected.length,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error("Agent spawn failed", { taskId, error });

    await recorder.patchMetadata({
      exitCode: 1,
      error,
      durationMs: Date.now() - startedAt,
    });

    taskRegistry.unregister(taskId);

    return {
      success: false,
      error,
      exitCode: 1,
      eventCount: 0,
    };
  }
}

/**
 * Cancel a running agent by task ID pattern.
 */
export function cancelAgent(pattern?: string): boolean {
  const backend = getBackend();
  if (pattern) {
    return backend.cancel(pattern);
  }
  backend.cancelAll();
  return true;
}

/**
 * Check if any spawned agents are currently running.
 */
export function hasRunningAgents(): boolean {
  const backend = getBackend();
  return backend.activeCount > 0;
}

/**
 * Get the number of active spawned agents.
 */
export function getActiveAgentCount(): number {
  const backend = getBackend();
  return backend.activeCount;
}
