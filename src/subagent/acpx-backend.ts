// src/subagent/acpx-backend.ts — ACP sub-agent spawning backend
// Spawns sub-agents via @agentclientprotocol/sdk with typed ACP JSON-RPC streaming.
// Falls back to legacy `claude -p --output-format stream-json` if agent command fails.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync, realpathSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { Writable, Readable } from "node:stream";
import { createLogger } from "../core/logger.js";
import {
  ACPX_AGENTS,
  type AcpxEvent,
  type AcpxResult,
  type AcpxSpawnOptions,
} from "./types.js";
import type { SubagentPermissionMode } from "../core/config.js";
import { DEFAULT_SUBAGENT_ALLOWED_TOOLS } from "../core/config.js";
import * as acp from "@agentclientprotocol/sdk";

const log = createLogger("subagent:acpx");

/** Agent command registry — maps agent names to spawn commands */
const AGENT_COMMANDS: Record<string, string> = {
  claude: "npx -y @agentclientprotocol/claude-agent-acp",
  codex: "npx @zed-industries/codex-acp",
  gemini: "gemini --acp",
  cursor: "cursor-agent acp",
  copilot: "copilot --acp --stdio",
  opencode: "npx -y opencode-ai acp",
  kimi: "kimi acp",
  qwen: "qwen --acp",
};

/** Maximum concurrent sub-agent processes allowed */
export const MAX_CONCURRENT_AGENTS = 5;

// ---------------------------------------------------------------------------
// JSON line parsing (legacy fallback only)
// ---------------------------------------------------------------------------

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
   * Parse agent command and spawn the agent process.
   * Returns the child process or throws if spawn fails.
   */
  private spawnAgentProcess(options: AcpxSpawnOptions): ChildProcess {
    const agentCommand = AGENT_COMMANDS[options.agent];
    if (!agentCommand) {
      throw new Error(`No command registered for agent: ${options.agent}`);
    }

    // Parse command into executable and args
    const parts = agentCommand.split(/\s+/);
    const executable = parts[0];
    const args = parts.slice(1);

    log.info(`Spawning ${options.agent} via ${agentCommand}`, { cwd: options.cwd });

    return spawn(executable, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin:${process.env.HOME}/.local/bin`,
      },
    });
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
   * Tries SDK-based spawn first using agent command registry.
   * Falls back to legacy `claude -p --output-format stream-json` if agent command fails.
   *
   * Yields a "start" event immediately, then streams events via SDK's sessionUpdate
   * handler. A final "done" event is always emitted when the process exits.
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

    // Try SDK-based spawn first, fall back to legacy claude -p
    let proc: ChildProcess;
    let useSDK = false;

    try {
      proc = this.spawnAgentProcess(options);
      useSDK = true;

      // Check for immediate spawn failure synchronously via error event
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

      log.info(`Agent command failed, falling back to claude -p`, { taskId, error: String(err) });

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
      useSDK = false;
    }

    this.processes.set(taskId, proc);

    // Yield start event
    yield { type: "start" };

    if (useSDK) {
      // SDK-based execution
      yield* this.runWithSDK(proc, options, taskId);
    } else {
      // Legacy execution
      yield* this.runLegacy(proc, options, taskId, parseJsonLine);
    }

    this.processes.delete(taskId);
  }

  /**
   * Run agent using SDK protocol.
   */
  private async *runWithSDK(
    proc: ChildProcess,
    options: AcpxSpawnOptions,
    taskId: string,
  ): AsyncGenerator<AcpxEvent> {
    const eventQueue: AcpxEvent[] = [];
    let resolveWait: (() => void) | undefined;

    function enqueue(event: AcpxEvent): void {
      eventQueue.push(event);
      resolveWait?.();
    }

    // Create SDK stream
    const input = Writable.toWeb(proc.stdin!);
    const output = Readable.toWeb(proc.stdout!);
    const stream = acp.ndJsonStream(input, output);

    // Create client with handlers
    const client = new acp.ClientSideConnection(
      (_agent) => ({
        // Permission handler — return cancelled (we use allowed-tools for permission)
        async requestPermission(_params) {
          return { outcome: { outcome: "cancelled" } };
        },
        // Session update handler — convert to AcpxEvent
        async sessionUpdate(params) {
          const update = params.update;
          switch (update.sessionUpdate) {
            case "agent_message_chunk":
              if (update.content.type === "text") {
                enqueue({ type: "message", content: update.content.text });
              }
              break;
            case "tool_call":
              if (update.status === "pending") {
                const meta = update._meta as Record<string, unknown> | undefined;
                const claudeCode = meta?.claudeCode as Record<string, unknown> | undefined;
                const toolName = String(claudeCode?.toolName ?? "");
                enqueue({
                  type: "tool_use",
                  toolName,
                  toolInput: update.rawInput,
                });
              }
              break;
            case "tool_call_update":
              if (update.status === "completed") {
                const meta = update._meta as Record<string, unknown> | undefined;
                const claudeCode = meta?.claudeCode as Record<string, unknown> | undefined;
                const toolName = String(claudeCode?.toolName ?? "");
                const rawOutput = update.rawOutput;
                enqueue({
                  type: "tool_result",
                  toolName,
                  toolResult: typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput),
                });
              }
              break;
          }
        },
      }),
      stream,
    );

    let exitCode = 0;
    let sdkDone = false;

    // Run SDK protocol in background
    (async () => {
      try {
        // Initialize connection
        await client.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });

        // Create session
        const sessionResult = await client.newSession({
          cwd: options.cwd,
          mcpServers: [],
        });

        // Send prompt
        const promptResult = await client.prompt({
          sessionId: sessionResult.sessionId,
          prompt: [{ type: "text", text: options.prompt }],
        });

        log.info(`Agent completed with ${promptResult.stopReason}`, { taskId });
        enqueue({ type: "done", exitCode: 0 });
      } catch (error) {
        log.error("SDK protocol error", { taskId, error });
        enqueue({ type: "error", error: String(error) });
        enqueue({ type: "done", exitCode: 1 });
      } finally {
        sdkDone = true;
        resolveWait?.();
      }
    })();

    // Handle process errors and exit
    proc.on("error", (err) => {
      enqueue({ type: "error", error: err.message });
      sdkDone = true;
      resolveWait?.();
    });

    proc.on("close", (code) => {
      exitCode = code ?? 0;
      if (!sdkDone) {
        // Process exited before SDK finished
        enqueue({ type: "done", exitCode });
        sdkDone = true;
        resolveWait?.();
      }
    });

    // Drain event queue
    while (true) {
      while (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      }

      if (sdkDone) break;

      await new Promise<void>((resolve) => {
        resolveWait = resolve;
      });
    }
  }

  /**
   * Run agent using legacy JSON-line parsing.
   */
  private async *runLegacy(
    proc: ChildProcess,
    options: AcpxSpawnOptions,
    taskId: string,
    lineParser: (line: string) => AcpxEvent | undefined,
  ): AsyncGenerator<AcpxEvent> {
    // Write prompt to stdin and close it
    if (proc.stdin) {
      proc.stdin.write(options.prompt);
      proc.stdin.end();
    }

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

    // Always yield a final done event
    yield { type: "done", exitCode };

    log.info(`Agent ${options.agent} completed`, { taskId, exitCode });
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
