// src/subagent/backend.ts — Subagent dispatcher
// Validates the request, manages concurrency / timeout / abort, and delegates
// the body of a run to the per-backend SubagentRunner registered for the
// requested `agent`.

import { existsSync, statSync, realpathSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { createLogger } from "../core/logger.js";
import {
  SUBAGENT_AGENTS,
  type SubagentAgent,
  type SubagentEvent,
  type SubagentResult,
  type SubagentSpawnOptions,
} from "./types.js";
import type { SubagentClaudeConfigFile, SubagentPermissionMode } from "../core/config.js";
import type { SubagentRunner } from "./runner.js";
import { ClaudeRunner } from "./runners/claude.js";
import { BuiltinRunner, type BuiltinPiMonoCore } from "./runners/builtin.js";

const log = createLogger("subagent:backend");

/** Maximum concurrent sub-agent runs allowed */
export const MAX_CONCURRENT_AGENTS = 5;

// Re-exported for backward compatibility with consumers that imported
// `mapSdkMessage` from this module before the runner split.
export { mapSdkMessage } from "./runners/claude.js";

/** Tracks an in-flight run so it can be cancelled. */
interface RunHandle {
  abort: AbortController;
}

/** Shared handle map across all SubagentBackend instances — lets cancel work across callers. */
const runs = new Map<string, RunHandle>();

export interface SubagentBackendOptions {
  /** Allowed workspace roots for cwd validation. Empty = unrestricted. */
  allowedWorkspaceRoots?: string[];
  /** Default permission mode for the Claude runner. Default: "allowlist" */
  permissionMode?: SubagentPermissionMode;
  /** Default tool allowlist for the Claude runner. */
  allowedTools?: string[];
  /** Claude-specific settings (auth, base URL, executable path). */
  claude?: SubagentClaudeConfigFile;
  /**
   * Core used to host in-process builtin subagents. When provided, a
   * BuiltinRunner is registered for the "builtin" agent. When omitted,
   * spawning a "builtin" agent throws.
   */
  core?: BuiltinPiMonoCore;
  /**
   * Pre-built runners. When provided, replaces the runners that would have
   * been built from the other options. Primarily a hook for tests.
   */
  runners?: Partial<Record<SubagentAgent, SubagentRunner>>;
}

/**
 * Dispatcher that routes subagent spawn requests to the runner registered
 * for the requested {@link SubagentAgent}. Owns cwd validation, concurrency
 * limiting, timeouts, and the abort handle map.
 */
export class SubagentBackend {
  private allowedRoots: string[];
  private runners: Partial<Record<SubagentAgent, SubagentRunner>>;
  /** Workspace key for singleton comparison (used by getBackend cache) */
  public workspacesKey: string;

  constructor(options?: string[] | SubagentBackendOptions) {
    const opts: SubagentBackendOptions = Array.isArray(options) || options === undefined
      ? { allowedWorkspaceRoots: options ?? [] }
      : options;

    this.allowedRoots = opts.allowedWorkspaceRoots ?? [];
    this.workspacesKey = this.allowedRoots.slice().sort().join(":");

    if (opts.runners) {
      this.runners = { ...opts.runners };
    } else {
      const claude = new ClaudeRunner({
        permissionMode: opts.permissionMode,
        allowedTools: opts.allowedTools,
        claude: opts.claude,
      });
      this.runners = { claude };
      if (opts.core) {
        this.runners.builtin = new BuiltinRunner(opts.core);
      }
    }
  }

  /**
   * Validate that the given cwd is a real directory within allowed workspaces.
   * Uses realpathSync to resolve symlinks and prevent escape attacks.
   */
  validateCwd(cwd: string): void {
    const resolved = resolve(cwd);
    let normalized: string;
    try {
      normalized = realpathSync(resolved);
    } catch {
      normalized = normalize(resolved);
    }

    if (!existsSync(normalized)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }
    if (!statSync(normalized).isDirectory()) {
      throw new Error(`Working directory is not a directory: ${cwd}`);
    }

    if (this.allowedRoots.length > 0) {
      const isAllowed = this.allowedRoots.some((root) => {
        let normalizedRoot: string;
        try {
          normalizedRoot = realpathSync(resolve(root));
        } catch {
          normalizedRoot = normalize(resolve(root));
        }
        return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + "/");
      });
      if (!isAllowed) {
        throw new Error(`Working directory outside allowed workspaces: ${cwd}`);
      }
    }
  }

  /** Validate that the agent name is one of the known subagent backends. */
  validateAgent(agent: string): void {
    if (!SUBAGENT_AGENTS.has(agent)) {
      throw new Error(`Unknown agent: ${agent}. Allowed: ${[...SUBAGENT_AGENTS].join(", ")}`);
    }
  }

  /**
   * Spawn a sub-agent and yield events as they arrive.
   *
   * Yields a leading "start" event, delegates the body to the runner
   * registered for `options.agent`, and ensures a terminal "done" event
   * is emitted even if the runner exits without one.
   */
  async *spawn(
    taskId: string,
    options: SubagentSpawnOptions,
  ): AsyncGenerator<SubagentEvent> {
    this.validateAgent(options.agent);
    this.validateCwd(options.cwd);

    const runner = this.runners[options.agent];
    if (!runner) {
      throw new Error(
        `No runner registered for agent "${options.agent}". ` +
          (options.agent === "builtin"
            ? "Pass `core` when constructing SubagentBackend to enable builtin subagents."
            : "Check SubagentBackend configuration."),
      );
    }

    if (runs.size >= MAX_CONCURRENT_AGENTS) {
      throw new Error(
        `Max concurrent sub-agents reached (${MAX_CONCURRENT_AGENTS}). Cancel existing tasks first.`,
      );
    }

    const abortController = new AbortController();
    runs.set(taskId, { abort: abortController });

    log.info(`Spawning ${options.agent} subagent`, { taskId, cwd: options.cwd });

    yield { type: "start" };

    const timeoutSec = options.timeout ?? 900;
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutSec * 1000);
    timeoutHandle.unref();

    let sawDone = false;
    try {
      for await (const ev of runner.run(taskId, options, { abort: abortController.signal })) {
        if (ev.type === "done") sawDone = true;
        yield ev;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "error", error: msg };
      if (!sawDone) {
        yield { type: "done", exitCode: 1 };
        sawDone = true;
      }
    } finally {
      clearTimeout(timeoutHandle);
      runs.delete(taskId);
    }

    if (!sawDone) {
      yield { type: "done", exitCode: 0 };
    }

    log.info(`${options.agent} subagent completed`, { taskId });
  }

  /**
   * Cancel a running sub-agent by aborting its run.
   * Returns true if a task was found and aborted.
   */
  cancel(taskId: string): boolean {
    const handle = runs.get(taskId);
    if (!handle) return false;
    log.info("Cancelling subagent", { taskId });
    handle.abort.abort();
    return true;
  }

  /** Check if a sub-agent task is currently running. */
  isRunning(taskId: string): boolean {
    return runs.has(taskId);
  }

  /** Number of currently active sub-agent runs. */
  get activeCount(): number {
    return runs.size;
  }

  /** Cancel all running sub-agent tasks. */
  cancelAll(): void {
    for (const taskId of [...runs.keys()]) {
      this.cancel(taskId);
    }
  }
}

/** Aggregate a fully-collected event list into a SubagentResult. Pure / sync-friendly. */
export function summarizeEvents(events: SubagentEvent[]): SubagentResult {
  let lastExitCode = 0;
  let costUsd: number | undefined;

  for (const event of events) {
    if (event.type === "done") {
      if (event.exitCode !== undefined) lastExitCode = event.exitCode;
      if (event.costUsd !== undefined) costUsd = event.costUsd;
    }
  }

  const messages = events
    .filter((e) => e.type === "message" && e.content)
    .map((e) => e.content!)
    .join("\n");

  const errors = events
    .filter((e) => e.type === "error" && e.error)
    .map((e) => e.error!)
    .join("\n");

  return {
    success: lastExitCode === 0 && !errors,
    output: messages || undefined,
    error: errors || undefined,
    events,
    exitCode: lastExitCode,
    costUsd,
  };
}

/** Collect all events from a spawn generator into a SubagentResult. */
export async function collectResult(
  events: AsyncGenerator<SubagentEvent>,
): Promise<SubagentResult> {
  const collected: SubagentEvent[] = [];
  for await (const event of events) collected.push(event);
  return summarizeEvents(collected);
}
