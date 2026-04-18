// src/tools/subagent.ts — Subagent tool for spawning Claude as a sub-agent
// Allows the main agent to delegate tasks to coding agents like Claude, Codex, etc.

import { createLogger } from "../core/logger.js";
import {
  SubagentBackend,
  SUBAGENT_AGENTS,
  summarizeEvents,
  type SubagentAgent,
  type SubagentEvent,
} from "../subagent/index.js";
import { taskRegistry } from "../subagent/task-registry.js";
import type { SubagentPermissionMode } from "../core/config.js";

const log = createLogger("tools:subagent");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the subagent backend (from acp.subagent in config) */
export interface SubagentBackendConfig {
  /** Permission mode for tool execution */
  permissionMode?: SubagentPermissionMode;
  /** Allowed tools for allowlist mode */
  allowedTools?: string[];
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

/**
 * Initialize the subagent backend with configuration.
 * Should be called during app startup with config from acp.subagent.
 * 
 * @param config - Configuration from resolveSubagentConfig()
 */
export function initSubagentBackend(config: SubagentBackendConfig): void {
  backendConfig = config;
  // Clear existing backend so it gets recreated with new config
  sharedBackend = undefined;
  sharedBackendKey = undefined;
  log.info("Subagent backend initialized", { 
    permissionMode: config.permissionMode ?? "allowlist",
    allowedTools: config.allowedTools,
  });
}

function getBackend(allowedWorkspaces?: string[]): SubagentBackend {
  // Create new backend if workspaces changed or not initialized
  const key = allowedWorkspaces?.sort().join(":") ?? "";
  if (!sharedBackend || sharedBackendKey !== key) {
    sharedBackend = new SubagentBackend({
      allowedWorkspaceRoots: allowedWorkspaces,
      permissionMode: backendConfig.permissionMode,
      allowedTools: backendConfig.allowedTools,
    });
    sharedBackendKey = key;
  }
  return sharedBackend;
}

/** Counter for generating unique task IDs */
let taskCounter = 0;

/**
 * Get the shared SubagentBackend instance for use by other modules (e.g. IterationExecutor).
 * Returns undefined if the backend hasn't been initialized (no permissionMode set).
 */
export function getSubagentBackend(allowedWorkspaces?: string[]): SubagentBackend | undefined {
  if (!backendConfig.permissionMode) {
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

  try {
    const events = backend.spawn(taskId, {
      agent,
      prompt,
      cwd: options.cwd,
      model: options.model,
      timeout: options.timeout,
      maxTurns: options.maxTurns ?? 50,
    });

    // Collect events, optionally streaming via callback
    const collected: SubagentEvent[] = [];
    for await (const event of events) {
      collected.push(event);
      options.onEvent?.(event);
    }

    // Build result from collected events
    const result = summarizeEvents(collected);

    log.info("Sub-agent completed", {
      taskId,
      success: result.success,
      exitCode: result.exitCode,
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
 * Get list of supported agent backends.
 */
export function getSupportedAgents(): readonly string[] {
  return [...SUBAGENT_AGENTS];
}

