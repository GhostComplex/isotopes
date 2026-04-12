// src/subagent/acpx-backend.ts — ACP sub-agent spawning backend
// Spawns sub-agents via `npx acpx --format json` with ACP JSON-RPC streaming.
// Falls back to legacy `claude -p --output-format stream-json` if acpx is unavailable.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync, realpathSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { createLogger } from "../core/logger.js";
import {
  ACPX_AGENTS,
  type AcpxEvent,
  type AcpxResult,
  type AcpxSpawnOptions,
} from "./types.js";
import type { SubagentPermissionMode } from "../core/config.js";
import { DEFAULT_SUBAGENT_ALLOWED_TOOLS } from "../core/config.js";

const log = createLogger("subagent:acpx");

/** Maximum concurrent sub-agent processes allowed */
export const MAX_CONCURRENT_AGENTS = 5;

// ---------------------------------------------------------------------------
// JSON line parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single ACP JSON-RPC notification line from acpx stdout into an AcpxEvent.
 * Handles session/update notifications with agent_message_chunk, tool_call,
 * tool_call_update, and final result messages.
 * Unrecognised lines are silently ignored (returns undefined).
 */
export function parseAcpxJsonLine(line: string): AcpxEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return undefined;

  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;

    // Final result with stopReason (JSON-RPC response with id)
    if (obj.id !== undefined && obj.result !== undefined) {
      const result = obj.result as Record<string, unknown>;
      if (result.stopReason) {
        return { type: "done", exitCode: 0 };
      }
      return undefined;
    }

    // JSON-RPC notification
    const method = obj.method as string | undefined;
    if (method !== "session/update") return undefined;

    const params = obj.params as Record<string, unknown> | undefined;
    if (!params) return undefined;

    const update = params.update as Record<string, unknown> | undefined;
    if (!update) return undefined;

    const sessionUpdate = update.sessionUpdate as string | undefined;
    if (!sessionUpdate) return undefined;

    switch (sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content as Record<string, unknown> | undefined;
        if (content?.type === "text" && typeof content.text === "string") {
          return { type: "message", content: content.text };
        }
        return undefined;
      }

      case "tool_call": {
        const status = update.status as string | undefined;
        if (status === "pending") {
          const meta = update._meta as Record<string, unknown> | undefined;
          const claudeCode = meta?.claudeCode as Record<string, unknown> | undefined;
          const toolName = String(claudeCode?.toolName ?? "");
          return {
            type: "tool_use",
            toolName,
            toolInput: update.rawInput,
          };
        }
        return undefined;
      }

      case "tool_call_update": {
        const status = update.status as string | undefined;
        if (status === "completed") {
          const meta = update._meta as Record<string, unknown> | undefined;
          const claudeCode = meta?.claudeCode as Record<string, unknown> | undefined;
          const toolName = String(claudeCode?.toolName ?? "");
          const rawOutput = update.rawOutput;
          return {
            type: "tool_result",
            toolName,
            toolResult: typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput),
          };
        }
        return undefined;
      }

      default:
        return undefined;
    }
  } catch {
    log.debug("Failed to parse acpx JSON-RPC line", trimmed);
    return undefined;
  }
}

/**
 * Parse a single JSON line from claude CLI stdout into an AcpxEvent.
 * Unrecognised lines are silently ignored (returns undefined).
 */
export function parseJsonLine(line: string): AcpxEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return undefined;

  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    return mapRawEvent(obj);
  } catch {
    log.debug("Failed to parse claude JSON line", trimmed);
    return undefined;
  }
}

/**
 * Map a raw JSON object from claude CLI to an AcpxEvent.
 *
 * Claude CLI stream-json format emits objects like:
 *   { type: "assistant", message: { content: [...] } }
 *   { type: "result", result: "...", cost_usd: 0.01 }
 */
function mapRawEvent(obj: Record<string, unknown>): AcpxEvent | undefined {
  const type = obj.type as string | undefined;
  if (!type) return undefined;

  switch (type) {
    // Claude CLI "assistant" message - contains content blocks
    case "assistant": {
      const message = obj.message as Record<string, unknown> | undefined;
      if (!message) return undefined;
      
      const content = message.content as Array<Record<string, unknown>> | undefined;
      if (!content || !Array.isArray(content)) return undefined;
      
      // Find text content
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          return { type: "message", content: block.text };
        }
        if (block.type === "tool_use") {
          return {
            type: "tool_use",
            toolName: String(block.name ?? ""),
            toolInput: block.input,
          };
        }
      }
      return undefined;
    }

    // Claude CLI "user" message - usually tool results
    case "user": {
      const message = obj.message as Record<string, unknown> | undefined;
      if (!message) return undefined;
      
      const content = message.content as Array<Record<string, unknown>> | undefined;
      if (!content || !Array.isArray(content)) return undefined;
      
      for (const block of content) {
        if (block.type === "tool_result") {
          return {
            type: "tool_result",
            toolName: String(block.tool_use_id ?? ""),
            toolResult: typeof block.content === "string" 
              ? block.content 
              : JSON.stringify(block.content),
          };
        }
      }
      return undefined;
    }

    // Claude CLI "result" - final result
    case "result": {
      const result = obj.result as string | undefined;
      const subtype = obj.subtype as string | undefined;
      
      if (subtype === "error_max_turns") {
        return { type: "error", error: "Max turns reached" };
      }
      
      // Result contains final text output
      if (result) {
        return { type: "message", content: result };
      }
      return undefined;
    }

    // Legacy acpx format support
    case "message":
      return {
        type: "message",
        content: String(obj.content ?? ""),
      };
    case "tool_use":
      return {
        type: "tool_use",
        toolName: String(obj.tool ?? obj.name ?? ""),
        toolInput: obj.input ?? obj.arguments,
      };
    case "tool_result":
      return {
        type: "tool_result",
        toolName: String(obj.tool ?? obj.name ?? ""),
        toolResult: String(obj.result ?? obj.output ?? ""),
      };
    case "error":
      return {
        type: "error",
        error: String(obj.error ?? obj.message ?? "unknown error"),
      };
    case "done":
      return {
        type: "done",
        exitCode: typeof obj.exitCode === "number" ? obj.exitCode : 0,
      };
    default:
      // Unknown event type — pass through as message if it has content
      if (typeof obj.content === "string") {
        return { type: "message", content: obj.content };
      }
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// AcpxBackend
// ---------------------------------------------------------------------------

/**
 * Configuration options for AcpxBackend (M8).
 */
export interface AcpxBackendOptions {
  /** Allowed workspace roots for cwd validation */
  allowedWorkspaceRoots?: string[];
  /**
   * Permission mode for tool execution (M8)
   * - "skip" — Use --dangerously-skip-permissions (full access, no prompts)
   * - "allowlist" — Use --allowedTools with configured list (recommended)
   * - "default" — Use claude CLI defaults (interactive prompts)
   * Default: "allowlist"
   */
  permissionMode?: SubagentPermissionMode;
  /**
   * Tool allowlist for "allowlist" permission mode (M8)
   * Default: ["Read", "Write", "Edit", "Glob", "Grep", "LS"]
   */
  allowedTools?: string[];
}

/**
 * Backend for spawning Claude Code sub-agent processes.
 *
 * Each task gets its own child process running
 * `claude -p --output-format stream-json <prompt>`.
 *
 * Events are streamed as an async generator from the process stdout.
 */
export class AcpxBackend {
  /** Active child processes keyed by taskId */
  private processes: Map<string, ChildProcess> = new Map();

  /** Allowed workspace roots for cwd validation */
  private allowedRoots: string[];

  /** Permission mode for tool execution (M8) */
  private permissionMode: SubagentPermissionMode;

  /** Tool allowlist for "allowlist" mode (M8) */
  private allowedTools: string[];

  /** Workspace key for singleton comparison (M8.5) */
  public workspacesKey: string;

  constructor(options?: string[] | AcpxBackendOptions) {
    // Support legacy constructor signature: new AcpxBackend(allowedWorkspaceRoots)
    if (Array.isArray(options) || options === undefined) {
      this.allowedRoots = options ?? [];
      this.permissionMode = "allowlist";
      this.allowedTools = [...DEFAULT_SUBAGENT_ALLOWED_TOOLS];
    } else {
      this.allowedRoots = options.allowedWorkspaceRoots ?? [];
      this.permissionMode = options.permissionMode ?? "allowlist";
      this.allowedTools = options.allowedTools ?? [...DEFAULT_SUBAGENT_ALLOWED_TOOLS];
    }

    // Compute workspace key for singleton comparison (M8.5)
    this.workspacesKey = this.allowedRoots.slice().sort().join(":");
  }

  /**
   * Validate that the given cwd is a real directory within allowed workspaces.
   * Uses realpathSync to resolve symlinks and prevent escape attacks (M8.3).
   * @throws Error if validation fails
   */
  validateCwd(cwd: string): void {
    const resolved = resolve(cwd);
    
    // M8.3: Use realpathSync when path exists to resolve symlinks
    let normalized: string;
    try {
      normalized = realpathSync(resolved);
    } catch {
      // Path doesn't exist yet — fall back to normalize
      normalized = normalize(resolved);
    }

    // Check directory exists
    if (!existsSync(normalized)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }

    // Check it's a directory
    const stat = statSync(normalized);
    if (!stat.isDirectory()) {
      throw new Error(`Working directory is not a directory: ${cwd}`);
    }

    // If allowed roots are configured, validate path is within them
    if (this.allowedRoots.length > 0) {
      const isAllowed = this.allowedRoots.some((root) => {
        // M8.3: Use realpathSync for allowed roots too
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

  /**
   * Validate that the agent name is a known agent.
   * @throws Error if validation fails
   */
  validateAgent(agent: string): void {
    if (!ACPX_AGENTS.has(agent)) {
      throw new Error(`Unknown agent: ${agent}. Allowed: ${[...ACPX_AGENTS].join(", ")}`);
    }
  }

  /**
   * Build the command-line arguments for `acpx`.
   *
   * Returns two arrays:
   * - preAgentArgs: Global flags BEFORE agent name (--cwd, --format, --approve-all)
   * - postAgentArgs: Command + flags AFTER agent name (exec, --file, --model, --max-turns)
   */
  buildAcpxArgs(options: AcpxSpawnOptions): { preAgentArgs: string[]; postAgentArgs: string[] } {
    const preAgentArgs: string[] = [
      "--cwd", options.cwd,
      "--format", "json",
    ];

    // Apply permission mode
    const permissionMode = options.permissionMode ?? this.permissionMode;
    const allowedTools = options.allowedTools ?? this.allowedTools;

    switch (permissionMode) {
      case "skip":
        preAgentArgs.push("--approve-all");
        log.debug("Using acpx with --approve-all (permissionMode 'skip')");
        break;
      case "allowlist":
        if (allowedTools.length > 0) {
          preAgentArgs.push("--allowed-tools", allowedTools.join(","));
          log.debug(`Using acpx with --allowed-tools: ${allowedTools.join(", ")}`);
        }
        break;
      case "default":
        log.debug("Using acpx with default permissions");
        break;
    }

    // --model, --max-turns, --timeout are global flags — must go BEFORE agent subcommand
    if (options.model) {
      preAgentArgs.push("--model", options.model);
    }

    if (options.maxTurns !== undefined) {
      preAgentArgs.push("--max-turns", String(options.maxTurns));
    }

    if (options.timeout !== undefined) {
      preAgentArgs.push("--timeout", String(options.timeout));
    }

    const postAgentArgs: string[] = ["exec", "--file", "-"];

    return { preAgentArgs, postAgentArgs };
  }

  /**
   * Build the command-line arguments for legacy `claude -p` fallback.
   * Note: prompt is passed via stdin, not as an argument.
   *
   * M8.1: Supports configurable permission modes:
   * - "skip" — --dangerously-skip-permissions (full access)
   * - "allowlist" — --allowedTools with configured list (recommended)
   * - "default" — no permission flags (uses claude CLI defaults)
   */
  buildLegacyArgs(options: AcpxSpawnOptions): string[] {
    const args: string[] = [
      "-p",  // Print mode (non-interactive)
      "--output-format", "stream-json",  // Stream JSON events
      "--verbose",  // Required for stream-json output
    ];

    // M8.1: Apply permission mode
    const permissionMode = options.permissionMode ?? this.permissionMode;
    const allowedTools = options.allowedTools ?? this.allowedTools;

    switch (permissionMode) {
      case "skip":
        // Full access without any permission prompts
        args.push("--dangerously-skip-permissions");
        log.debug("Using permissionMode 'skip' — all tool calls auto-approved");
        break;

      case "allowlist":
        // Use --allowedTools with configured list
        if (allowedTools.length > 0) {
          args.push("--allowedTools", ...allowedTools);
          log.debug(`Using permissionMode 'allowlist' with tools: ${allowedTools.join(", ")}`);
        } else {
          // Empty allowlist — use default mode
          log.debug("permissionMode 'allowlist' with empty tools list — using defaults");
        }
        break;

      case "default":
        // No permission flags — use claude CLI defaults (interactive prompts)
        log.debug("Using permissionMode 'default' — claude CLI default behavior");
        break;
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    if (options.maxTurns !== undefined) {
      args.push("--max-turns", String(options.maxTurns));
    }

    // Note: prompt is NOT added here - it's passed via stdin

    return args;
  }

  /**
   * Spawn a sub-agent and yield events as they arrive.
   *
   * Tries acpx first (`npx acpx ...`). If acpx spawn fails (ENOENT),
   * falls back to legacy `claude -p --output-format stream-json` mode.
   *
   * Yields a "start" event immediately, then streams JSON-line events
   * from stdout. Errors on stderr are accumulated and emitted as error
   * events. A final "done" event is always emitted when the process exits.
   *
   * @param taskId - Unique identifier for this task (used for cancellation)
   * @param options - Spawn options (agent, prompt, cwd, etc.)
   * @throws Error if validation fails or max concurrent limit reached
   */
  async *spawn(
    taskId: string,
    options: AcpxSpawnOptions,
  ): AsyncGenerator<AcpxEvent> {
    // Security: validate agent name at runtime
    this.validateAgent(options.agent);

    // Security: validate cwd is a real directory within allowed workspaces
    this.validateCwd(options.cwd);

    // Security: enforce concurrent process limit
    if (this.processes.size >= MAX_CONCURRENT_AGENTS) {
      throw new Error(
        `Max concurrent sub-agents reached (${MAX_CONCURRENT_AGENTS}). Cancel existing tasks first.`
      );
    }

    // Try acpx first, fall back to legacy claude -p
    let proc: ChildProcess;
    let lineParser: (line: string) => AcpxEvent | undefined;

    try {
      const { preAgentArgs, postAgentArgs } = this.buildAcpxArgs(options);
      const acpxArgs = ["acpx", ...preAgentArgs, options.agent, ...postAgentArgs];

      log.info(`Spawning acpx ${options.agent}`, { taskId, cwd: options.cwd, args: acpxArgs });

      proc = spawn(
        "npx",
        acpxArgs,
        {
          cwd: options.cwd,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin:${process.env.HOME}/.local/bin`,
          },
        },
      );
      lineParser = parseAcpxJsonLine;

      // Check for immediate spawn failure (ENOENT) synchronously via error event
      const spawnError = await new Promise<Error | null>((resolve) => {
        proc.once("error", (err) => resolve(err));
        // If no error fires on next tick, spawn succeeded
        setImmediate(() => resolve(null));
      });

      if (spawnError) {
        throw spawnError;
      }
    } catch (err) {
      // Fall back to legacy claude -p mode
      const legacyArgs = this.buildLegacyArgs(options);

      log.info(`acpx not available, falling back to claude -p`, { taskId, error: String(err) });

      proc = spawn(
        "claude",
        legacyArgs,
        {
          cwd: options.cwd,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin:${process.env.HOME}/.local/bin`,
          },
        },
      );
      lineParser = parseJsonLine;
    }

    this.processes.set(taskId, proc);

    // Write prompt to stdin and close it
    if (proc.stdin) {
      proc.stdin.write(options.prompt);
      proc.stdin.end();
    }

    // Yield start event
    yield { type: "start" };

    // Buffer for incomplete lines
    let stdoutBuffer = "";
    let stderrBuffer = "";

    // Collect events in a queue that the generator pulls from
    const eventQueue: AcpxEvent[] = [];
    let processExited = false;
    let exitCode = 0;
    let resolveWait: (() => void) | undefined;

    function enqueue(event: AcpxEvent): void {
      eventQueue.push(event);
      resolveWait?.();
    }

    // Handle stdout — JSON lines
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      // Keep the last incomplete line in the buffer
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const event = lineParser(line);
        if (event) {
          enqueue(event);
        }
      }
    });

    // Handle stderr — accumulate error text
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    // Handle process exit
    proc.on("close", (code) => {
      // Flush remaining stdout buffer
      if (stdoutBuffer.trim()) {
        const event = lineParser(stdoutBuffer);
        if (event) {
          enqueue(event);
        }
      }

      // Emit stderr as error event only if process actually failed (non-zero exit)
      // acpx may log warnings like "Error handling notification" to stderr even on success
      const stderr = stderrBuffer.trim();
      if (stderr && code !== 0) {
        enqueue({ type: "error", error: stderr });
      }

      exitCode = code ?? 0;
      processExited = true;
      resolveWait?.();
    });

    proc.on("error", (err) => {
      enqueue({ type: "error", error: err.message });
      processExited = true;
      resolveWait?.();
    });

    // Drain the event queue
    try {
      while (true) {
        // Yield any queued events
        while (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        }

        // If process has exited and queue is empty, we're done
        if (processExited) break;

        // Wait for more events
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
        });
      }
    } finally {
      this.processes.delete(taskId);
    }

    // Always yield a final done event
    yield { type: "done", exitCode };

    log.info(`claude ${options.agent} completed`, { taskId, exitCode });
  }

  /**
   * Cancel a running sub-agent process.
   *
   * Sends SIGTERM first, then SIGKILL after 5 seconds if still running.
   *
   * @param taskId - The task to cancel
   * @returns true if a process was found and signalled
   */
  cancel(taskId: string): boolean {
    const proc = this.processes.get(taskId);
    if (!proc || proc.killed) {
      return false;
    }

    log.info(`Cancelling claude task`, { taskId });

    proc.kill("SIGTERM");

    // Force-kill after 5 seconds
    const timer = setTimeout(() => {
      if (!proc.killed) {
        proc.kill("SIGKILL");
      }
    }, 5_000);

    // Ensure timer doesn't prevent Node from exiting and is cleaned up
    timer.unref();
    proc.once("close", () => clearTimeout(timer));

    return true;
  }

  /**
   * Check if a sub-agent process is currently running.
   *
   * @param taskId - The task to check
   * @returns true if the process exists and has not exited
   */
  isRunning(taskId: string): boolean {
    const proc = this.processes.get(taskId);
    return !!proc && !proc.killed && proc.exitCode === null;
  }

  /**
   * Get the number of currently active processes.
   */
  get activeCount(): number {
    return this.processes.size;
  }

  /**
   * Cancel all running processes.
   */
  cancelAll(): void {
    for (const taskId of [...this.processes.keys()]) {
      this.cancel(taskId);
    }
  }
}

/**
 * Collect all events from a spawn generator into an AcpxResult.
 */
export async function collectResult(
  events: AsyncGenerator<AcpxEvent>,
): Promise<AcpxResult> {
  const collected: AcpxEvent[] = [];
  let lastExitCode = 0;

  for await (const event of events) {
    collected.push(event);
    if (event.type === "done" && event.exitCode !== undefined) {
      lastExitCode = event.exitCode;
    }
  }

  const messages = collected
    .filter((e) => e.type === "message" && e.content)
    .map((e) => e.content!)
    .join("\n");

  const errors = collected
    .filter((e) => e.type === "error" && e.error)
    .map((e) => e.error!)
    .join("\n");

  return {
    success: lastExitCode === 0 && !errors,
    output: messages || undefined,
    error: errors || undefined,
    events: collected,
    exitCode: lastExitCode,
  };
}
