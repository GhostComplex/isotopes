// src/subagent/acpx-backend.ts — acpx sub-agent spawning backend
// Wraps `npx acpx <agent> exec` as a child process with JSON line streaming.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { createLogger } from "../core/logger.js";
import {
  ACPX_AGENTS,
  type AcpxEvent,
  type AcpxResult,
  type AcpxSpawnOptions,
} from "./types.js";

const log = createLogger("subagent:acpx");

/** Maximum concurrent sub-agent processes allowed */
export const MAX_CONCURRENT_AGENTS = 5;

// ---------------------------------------------------------------------------
// JSON line parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single JSON line from acpx stdout into an AcpxEvent.
 * Unrecognised lines are silently ignored (returns undefined).
 */
export function parseJsonLine(line: string): AcpxEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return undefined;

  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    return mapRawEvent(obj);
  } catch {
    log.debug("Failed to parse acpx JSON line", trimmed);
    return undefined;
  }
}

/**
 * Map a raw JSON object to an AcpxEvent.
 *
 * Expected fields:
 *   { type: "message" | "tool_use" | "tool_result" | "error" | "done", ... }
 */
function mapRawEvent(obj: Record<string, unknown>): AcpxEvent | undefined {
  const type = obj.type as string | undefined;
  if (!type) return undefined;

  switch (type) {
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
 * Backend for spawning acpx sub-agent processes.
 *
 * Each task gets its own child process running
 * `npx acpx <agent> exec --format json --approve-all <prompt>`.
 *
 * Events are streamed as an async generator from the process stdout.
 */
export class AcpxBackend {
  /** Active child processes keyed by taskId */
  private processes: Map<string, ChildProcess> = new Map();

  /** Allowed workspace roots for cwd validation */
  private allowedRoots: string[];

  constructor(allowedWorkspaceRoots?: string[]) {
    this.allowedRoots = allowedWorkspaceRoots ?? [];
  }

  /**
   * Validate that the given cwd is a real directory within allowed workspaces.
   * @throws Error if validation fails
   */
  validateCwd(cwd: string): void {
    const resolved = resolve(cwd);
    const normalized = normalize(resolved);

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
        const normalizedRoot = normalize(resolve(root));
        return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + "/");
      });
      if (!isAllowed) {
        throw new Error(`Working directory outside allowed workspaces: ${cwd}`);
      }
    }
  }

  /**
   * Validate that the agent name is a known acpx agent.
   * @throws Error if validation fails
   */
  validateAgent(agent: string): void {
    if (!ACPX_AGENTS.has(agent)) {
      throw new Error(`Unknown agent: ${agent}. Allowed: ${[...ACPX_AGENTS].join(", ")}`);
    }
  }

  /**
   * Build the command-line arguments for `npx acpx <agent> exec`.
   */
  buildArgs(options: AcpxSpawnOptions): string[] {
    const args: string[] = ["--format", "json"];

    if (options.approveAll !== false) {
      args.push("--approve-all");
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    if (options.timeout !== undefined) {
      args.push("--timeout", String(options.timeout));
    }

    if (options.maxTurns !== undefined) {
      args.push("--max-turns", String(options.maxTurns));
    }

    // Prompt is the final positional argument
    args.push(options.prompt);

    return args;
  }

  /**
   * Spawn an acpx sub-agent and yield events as they arrive.
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

    const args = this.buildArgs(options);

    log.info(`Spawning acpx ${options.agent} exec`, { taskId, cwd: options.cwd });

    const proc = spawn(
      "acpx",
      [options.agent, "exec", ...args],
      {
        cwd: options.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    this.processes.set(taskId, proc);

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
        const event = parseJsonLine(line);
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
        const event = parseJsonLine(stdoutBuffer);
        if (event) {
          enqueue(event);
        }
      }

      // Emit stderr as error event if present
      if (stderrBuffer.trim()) {
        enqueue({ type: "error", error: stderrBuffer.trim() });
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

    log.info(`acpx ${options.agent} exec completed`, { taskId, exitCode });
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

    log.info(`Cancelling acpx task`, { taskId });

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
