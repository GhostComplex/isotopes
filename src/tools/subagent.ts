// src/tools/subagent.ts — Subagent tool for spawning Claude as a sub-agent
// Allows the main agent to delegate tasks to coding agents like Claude, Codex, etc.

import { createLogger } from "../core/logger.js";
import {
  SubagentBackend,
  summarizeEvents,
  type SubagentAgent,
  type SubagentEvent,
} from "../subagent/index.js";
import type { BuiltinSubagentOptions } from "../subagent/types.js";
import type { BuiltinPiMonoCore } from "../subagent/runners/builtin.js";
import { taskRegistry } from "../subagent/task-registry.js";
import { createSubagentRecorder } from "../subagent/persistence.js";
import type { SessionStore } from "../core/types.js";
import type { ResolvedSubagentConfig } from "../core/config.js";

const log = createLogger("tools:subagent");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the subagent backend */
export interface SubagentBackendConfig {
  /** Resolved subagent config from config.ts */
  config?: ResolvedSubagentConfig;
  /** AgentCore used to host in-process builtin subagents. */
  core?: BuiltinPiMonoCore;
}

/** Options for spawning a sub-agent */
export interface SpawnSubagentOptions {
  /** Which agent to use (default: claude) */
  agent?: SubagentAgent;
  /** Working directory for the agent (required) */
  cwd: string;
  /** Model override */
  model?: string;
  /** Timeout in seconds (default: 300) */
  timeout?: number;
  /** Maximum turns (default: 50) */
  maxTurns?: number;
  /** Allowed workspace roots for validation */
  allowedWorkspaces?: string[];
  /** Callback for streaming events */
  onEvent?: (event: SubagentEvent) => void;
  /** Session ID for task registry tracking */
  sessionId?: string;
  /** Channel ID for task registry tracking */
  channelId?: string;
  /** Thread ID where subagent streams output (for /stop support) */
  threadId?: string;
  /** Parent agent id, used as the owner of the persisted subagent session. */
  parentAgentId?: string;
  /**
   * Real agentId to record this run under. Named subagents pass their own
   * id (e.g. `code-reviewer`); anonymous/dynamic subagents leave this
   * unset and the recorder falls back to `parentAgentId`. See
   * docs/subagent-architecture.md §4.4.
   */
  targetAgentId?: string;
  /** Builtin-backend-specific options. Required when agent === "builtin". */
  builtin?: BuiltinSubagentOptions;
}

/** Result from spawning a sub-agent */
export interface SpawnSubagentResult {
  success: boolean;
  output?: string;
  error?: string;
  exitCode: number;
  eventCount: number;
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

/** Shared backend instance (lazy initialized) */
let sharedBackend: SubagentBackend | undefined;

/** Cache key for the shared backend (workspace roots joined by `:`) */
let sharedBackendKey: string | undefined;

/** Cached backend config */
let backendConfig: SubagentBackendConfig = {};

/** Optional factory for resolving the SessionStore to use for a given target agentId. */
let subagentStoreFactory: ((agentId: string) => Promise<SessionStore | undefined> | SessionStore | undefined) | undefined;

/**
 * Register a factory that resolves the SessionStore for a target agent's
 * subagent runs. The factory is called once per spawn with the resolved
 * `targetAgentId` (defaulted to `parentAgentId` for anonymous runs).
 *
 * Pass `undefined` to disable persistence (default).
 */
export function setSubagentSessionStoreFactory(
  factory: ((agentId: string) => Promise<SessionStore | undefined> | SessionStore | undefined) | undefined,
): void {
  subagentStoreFactory = factory;
}

/**
 * Initialize the subagent backend with configuration.
 * Should be called during app startup with config from `subagent`.
 * 
 * @param config - Configuration from resolveSubagentConfig()
 */
export function initSubagentBackend(config: SubagentBackendConfig): void {
  backendConfig = config;
  sharedBackend = undefined;
  sharedBackendKey = undefined;
  log.info("Subagent backend initialized", {
    allowedTypes: config.config?.allowedTypes ? [...config.config.allowedTypes] : undefined,
    claudePermissionMode: config.config?.claude.permissionMode,
  });
}

function getBackend(allowedWorkspaces?: string[]): SubagentBackend {
  const key = allowedWorkspaces?.sort().join(":") ?? "";
  if (!sharedBackend || sharedBackendKey !== key) {
    sharedBackend = new SubagentBackend({
      allowedWorkspaceRoots: allowedWorkspaces,
      config: backendConfig.config,
      core: backendConfig.core,
    });
    sharedBackendKey = key;
  }
  return sharedBackend;
}

/** Counter for generating unique task IDs */
let taskCounter = 0;

/**
 * Get the shared SubagentBackend instance for use by other modules.
 * Returns undefined if the backend hasn't been initialized.
 */
export function getSubagentBackend(allowedWorkspaces?: string[]): SubagentBackend | undefined {
  if (!backendConfig.config) {
    return undefined;
  }
  return getBackend(allowedWorkspaces);
}

/**
 * Spawn a sub-agent to execute a task.
 *
 * This tool allows the main agent to delegate complex tasks (like coding,
 * refactoring, debugging) to specialized coding agents.
 *
 * @param prompt - The task description for the sub-agent
 * @param options - Spawn options
 * @returns Result with output or error
 *
 * @example
 * ```typescript
 * const result = await spawnSubagent(
 *   "Fix the bug in src/main.ts that causes the crash",
 *   { agent: "claude", cwd: "/project" }
 * );
 * if (result.success) {
 *   console.log("Task completed:", result.output);
 * }
 * ```
 */
export async function spawnSubagent(
  prompt: string,
  options: SpawnSubagentOptions,
): Promise<SpawnSubagentResult> {
  const agent = options.agent ?? "claude";
  const taskId = `subagent-${++taskCounter}-${Date.now()}`;

  log.info("Spawning sub-agent", { taskId, agent, cwd: options.cwd });

  const backend = getBackend(options.allowedWorkspaces);

  // Register task for tracking/abort
  taskRegistry.register(taskId, options.sessionId ?? "", options.channelId ?? "", prompt);

  // Set threadId if provided (for /stop support in threads)
  if (options.threadId) {
    taskRegistry.setThreadId(taskId, options.threadId);
  }

  // Bind to SessionStore (no-op when no factory has been registered).
  const parentAgentId = options.parentAgentId ?? "unknown";
  const targetAgentId = options.targetAgentId ?? parentAgentId;
  const store = subagentStoreFactory ? await subagentStoreFactory(targetAgentId) : undefined;

  const recorder = await createSubagentRecorder({
    store,
    targetAgentId,
    parentAgentId,
    parentSessionId: options.sessionId,
    taskId,
    backend: agent,
    cwd: options.cwd,
    prompt,
    channelId: options.channelId,
    threadId: options.threadId,
  });

  const startedAt = Date.now();

  try {
    const events = backend.spawn(taskId, {
      agent,
      prompt,
      cwd: options.cwd,
      model: options.model,
      timeout: options.timeout,
      maxTurns: options.maxTurns ?? 50,
      ...(options.builtin ? { builtin: options.builtin } : {}),
    });

    // Collect events, optionally streaming via callback
    const collected: SubagentEvent[] = [];
    for await (const event of events) {
      collected.push(event);
      options.onEvent?.(event);
      await recorder.record(event);
    }

    // Build result from collected events
    const result = summarizeEvents(collected);

    log.info("Sub-agent completed", {
      taskId,
      success: result.success,
      exitCode: result.exitCode,
    });

    await recorder.patchMetadata({
      exitCode: result.exitCode,
      costUsd: collected.find((e) => e.costUsd !== undefined)?.costUsd,
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
    log.error("Sub-agent failed", { taskId, error });

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
 * Cancel a running sub-agent by task ID pattern.
 *
 * @param pattern - Task ID or pattern to match
 * @returns true if any tasks were cancelled
 */
export function cancelSubagent(pattern?: string): boolean {
  const backend = getBackend();
  if (pattern) {
    return backend.cancel(pattern);
  }
  backend.cancelAll();
  return true;
}

/**
 * Check if any sub-agents are currently running.
 */
export function hasRunningSubagents(): boolean {
  const backend = getBackend();
  return backend.activeCount > 0;
}

/**
 * Get the number of active sub-agents.
 */
export function getActiveSubagentCount(): number {
  const backend = getBackend();
  return backend.activeCount;
}

/**
 * Get list of supported agent backends from config.
 */
export function getSupportedAgents(): readonly string[] {
  return backendConfig.config?.allowedTypes ? [...backendConfig.config.allowedTypes] : ["claude", "builtin"];
}

