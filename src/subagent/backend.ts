// src/subagent/backend.ts — Subagent spawning backend via @anthropic-ai/claude-agent-sdk
// Wraps the SDK's query() so the main agent can delegate tasks to Claude Code
// as a one-shot run, producing an event stream consumed by discord-sink, iteration, etc.

import { existsSync, statSync, realpathSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { query, type Options, type PermissionMode, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../core/logger.js";
import {
  SUBAGENT_AGENTS,
  type SubagentEvent,
  type SubagentResult,
  type SubagentSpawnOptions,
} from "./types.js";
import type { SubagentClaudeConfigFile, SubagentPermissionMode } from "../core/config.js";
import { DEFAULT_SUBAGENT_ALLOWED_TOOLS } from "../core/config.js";

const log = createLogger("subagent:backend");

/** Maximum concurrent sub-agent runs allowed */
export const MAX_CONCURRENT_AGENTS = 5;

// ---------------------------------------------------------------------------
// SDK message → SubagentEvent mapping
// ---------------------------------------------------------------------------

/**
 * Map a single SDK message into zero or more SubagentEvents.
 *
 * Pass a persistent `toolNameById` map across calls to resolve `tool_result`
 * blocks back to the real tool name (Read/Edit/...): tool_use blocks carry
 * both id and name; tool_result blocks only carry the id. Without the map,
 * tool_result events fall back to the opaque `tool_use_id`.
 *
 * Exported for unit testing.
 */
export function mapSdkMessage(
  msg: SDKMessage,
  toolNameById?: Map<string, string>,
): SubagentEvent[] {
  const events: SubagentEvent[] = [];

  switch (msg.type) {
    case "assistant": {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
            events.push({ type: "message", content: block.text });
          } else if (block.type === "tool_use") {
            const name = String(block.name ?? "");
            if (toolNameById && typeof block.id === "string") toolNameById.set(block.id, name);
            events.push({
              type: "tool_use",
              toolName: name,
              toolInput: block.input,
            });
          }
        }
      }
      return events;
    }

    case "user": {
      // SDKUserMessageReplay has isReplay:true — skip those (they're just history echoes)
      if ("isReplay" in msg && msg.isReplay) return events;

      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            block.type === "tool_result"
          ) {
            const b = block as { tool_use_id?: string; content?: unknown };
            const id = String(b.tool_use_id ?? "");
            events.push({
              type: "tool_result",
              toolName: toolNameById?.get(id) ?? id,
              toolResult: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
            });
          }
        }
      }
      return events;
    }

    case "result": {
      if (msg.subtype === "success") {
        events.push({ type: "done", exitCode: 0, costUsd: msg.total_cost_usd });
      } else {
        // error subtypes: error_during_execution | error_max_turns | error_max_budget_usd | error_max_structured_output_retries
        const errMsg = msg.errors?.join("; ") ?? msg.subtype;
        events.push({ type: "error", error: errMsg });
        events.push({ type: "done", exitCode: 1, costUsd: msg.total_cost_usd });
      }
      return events;
    }

    default:
      // system/stream_event/tool_progress/auth_status — ignored (init/partials/progress)
      return events;
  }
}

// ---------------------------------------------------------------------------
// Permission mode translation
// ---------------------------------------------------------------------------

/**
 * Translate isotopes' permission mode into SDK options.
 * - skip → bypassPermissions (no gating)
 * - allowlist → default mode + allowedTools
 * - default → default mode (no allowedTools restriction)
 */
function translatePermissionMode(
  mode: SubagentPermissionMode,
  allowedTools: string[],
): { permissionMode: PermissionMode; allowedTools?: string[] } {
  switch (mode) {
    case "skip":
      return { permissionMode: "bypassPermissions" };
    case "allowlist":
      return { permissionMode: "default", allowedTools };
    case "default":
      return { permissionMode: "default" };
  }
}

// ---------------------------------------------------------------------------
// SubagentBackend
// ---------------------------------------------------------------------------

/** Tracks an in-flight SDK run so it can be cancelled. */
interface RunHandle {
  abort: AbortController;
}

/** Shared handle map across all SubagentBackend instances — lets cancel work across callers. */
const runs = new Map<string, RunHandle>();

export interface SubagentBackendOptions {
  /** Allowed workspace roots for cwd validation. Empty = unrestricted. */
  allowedWorkspaceRoots?: string[];
  /** Permission mode for tool execution. Default: "allowlist" */
  permissionMode?: SubagentPermissionMode;
  /** Tool allowlist for "allowlist" mode. Default: DEFAULT_SUBAGENT_ALLOWED_TOOLS */
  allowedTools?: string[];
  /** Claude-specific settings (auth, base URL, executable path) */
  claude?: SubagentClaudeConfigFile;
}

/**
 * Backend for running Claude as a sub-agent via @anthropic-ai/claude-agent-sdk.
 *
 * Each task runs one `query()` call and streams SDK messages, which are mapped
 * to the existing SubagentEvent union consumed by discord-sink, iteration, etc.
 */
export class SubagentBackend {
  private allowedRoots: string[];
  private permissionMode: SubagentPermissionMode;
  private allowedTools: string[];
  private claude?: SubagentClaudeConfigFile;
  /** Workspace key for singleton comparison (used by getBackend cache) */
  public workspacesKey: string;

  constructor(options?: string[] | SubagentBackendOptions) {
    if (Array.isArray(options) || options === undefined) {
      this.allowedRoots = options ?? [];
      this.permissionMode = "allowlist";
      this.allowedTools = [...DEFAULT_SUBAGENT_ALLOWED_TOOLS];
    } else {
      this.allowedRoots = options.allowedWorkspaceRoots ?? [];
      this.permissionMode = options.permissionMode ?? "allowlist";
      this.allowedTools = options.allowedTools ?? [...DEFAULT_SUBAGENT_ALLOWED_TOOLS];
      this.claude = options.claude;
    }
    this.workspacesKey = this.allowedRoots.slice().sort().join(":");
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
   * Build the SDK Options object for this spawn, combining backend defaults
   * with per-spawn overrides.
   */
  buildSdkOptions(
    options: SubagentSpawnOptions,
    abortController: AbortController,
  ): Options {
    const permissionMode = options.permissionMode ?? this.permissionMode;
    const allowedTools = options.allowedTools ?? this.allowedTools;
    const translated = translatePermissionMode(permissionMode, allowedTools);

    const sdkOptions: Options = {
      cwd: options.cwd,
      abortController,
      permissionMode: translated.permissionMode,
    };
    if (translated.allowedTools) sdkOptions.allowedTools = translated.allowedTools;
    if (options.model) sdkOptions.model = options.model;
    if (options.maxTurns !== undefined) sdkOptions.maxTurns = options.maxTurns;
    if (this.claude?.pathToClaudeCodeExecutable) {
      sdkOptions.pathToClaudeCodeExecutable = this.claude.pathToClaudeCodeExecutable;
    }

    // Inject Claude credentials into the spawned process's env without
    // mutating the parent's process.env. Only set when configured — if
    // unset, the SDK falls back to its normal process.env defaults.
    const envOverrides: Record<string, string> = {};
    if (this.claude?.authToken) envOverrides.ANTHROPIC_AUTH_TOKEN = this.claude.authToken;
    if (this.claude?.baseUrl) envOverrides.ANTHROPIC_BASE_URL = this.claude.baseUrl;
    if (Object.keys(envOverrides).length > 0) {
      sdkOptions.env = { ...process.env, ...envOverrides };
    }

    return sdkOptions;
  }

  /**
   * Spawn a sub-agent and yield events as they arrive.
   *
   * Yields a "start" event immediately, then message/tool_use/tool_result events
   * mapped from the SDK stream, and a final "done" (and optional "error") event
   * when the run completes.
   */
  async *spawn(
    taskId: string,
    options: SubagentSpawnOptions,
  ): AsyncGenerator<SubagentEvent> {
    this.validateAgent(options.agent);
    this.validateCwd(options.cwd);

    if (runs.size >= MAX_CONCURRENT_AGENTS) {
      throw new Error(
        `Max concurrent sub-agents reached (${MAX_CONCURRENT_AGENTS}). Cancel existing tasks first.`,
      );
    }

    const abortController = new AbortController();
    runs.set(taskId, { abort: abortController });

    log.info(`Spawning ${options.agent} subagent`, { taskId, cwd: options.cwd });

    yield { type: "start" };

    // Timeout: abort after N seconds. Default 900s (15 min) — single source of truth.
    const timeoutSec = options.timeout ?? 900;
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutSec * 1000);
    timeoutHandle.unref();

    let sawDone = false;
    // tool_use blocks carry name+id; tool_result blocks only carry the id.
    // Per-spawn map shared with mapSdkMessage so consumers see real tool names.
    const toolNameById = new Map<string, string>();
    try {
      const iterator = query({
        prompt: options.prompt,
        options: this.buildSdkOptions(options, abortController),
      });

      for await (const msg of iterator) {
        for (const ev of mapSdkMessage(msg, toolNameById)) {
          if (ev.type === "done") sawDone = true;
          yield ev;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // AbortError is expected on cancel; translate to a clean error event.
      yield { type: "error", error: msg };
      if (!sawDone) {
        yield { type: "done", exitCode: 1 };
        sawDone = true;
      }
    } finally {
      clearTimeout(timeoutHandle);
      runs.delete(taskId);
    }

    // Safety net: ensure at least one done event was emitted.
    if (!sawDone) {
      yield { type: "done", exitCode: 0 };
    }

    log.info(`${options.agent} subagent completed`, { taskId });
  }

  /**
   * Cancel a running sub-agent by aborting its SDK query.
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
