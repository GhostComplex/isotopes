// src/subagent/claude-runner.ts — Spawn Claude Code CLI as a subprocess
// Runs `claude --print --output-format=stream-json` and streams parsed events
// back to callers. Supports cancel/timeout and graceful shutdown.

import { spawn, type ChildProcess } from "node:child_process";
import { createLogger } from "../core/logger.js";
import { JsonStreamParser } from "./json-stream-parser.js";

const log = createLogger("subagent:claude-runner");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the Claude CLI runner. */
export interface ClaudeRunnerConfig {
  /** Path to the claude CLI binary (default: "claude"). */
  cliPath?: string;
  /** Default timeout in milliseconds (default: 600_000 = 10 min). */
  timeout?: number;
  /** Permission mode for the CLI (default: "bypassPermissions"). */
  permissionMode?: "default" | "bypassPermissions";
}

/** A single task to run via the Claude CLI. */
export interface ClaudeTask {
  /** Unique identifier for this task. */
  id: string;
  /** The prompt to send to Claude. */
  prompt: string;
  /** Working directory for the subprocess. */
  workdir: string;
  /** Callback invoked for each streaming event. */
  onEvent?: (event: ClaudeEvent) => void;
  /** Timeout override for this task (ms). */
  timeout?: number;
}

/** Normalized event types from the Claude CLI stream. */
export type ClaudeEventType =
  | "assistant_message"
  | "tool_use"
  | "tool_result"
  | "thinking"
  | "error"
  | "done";

/** A single parsed event from the Claude CLI stream. */
export interface ClaudeEvent {
  type: ClaudeEventType;
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: string;
  error?: string;
}

/** Result of a completed Claude CLI task. */
export interface ClaudeResult {
  success: boolean;
  output?: string;
  error?: string;
  events: ClaudeEvent[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CLI_PATH = "claude";
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
const DEFAULT_PERMISSION_MODE = "bypassPermissions";
const SIGKILL_DELAY_MS = 5_000; // wait 5s after SIGTERM before SIGKILL

// ---------------------------------------------------------------------------
// ClaudeRunner
// ---------------------------------------------------------------------------

/**
 * Manages spawning and lifecycle of Claude Code CLI subprocesses.
 *
 * Each task is spawned as a child process running:
 *   `claude --print --output-format=stream-json --permission-mode=<mode> -p <prompt>`
 *
 * Events are parsed from stdout in real-time via {@link JsonStreamParser}
 * and forwarded to the caller's `onEvent` callback.
 */
export class ClaudeRunner {
  private processes = new Map<string, ChildProcess>();
  private cliPath: string;
  private defaultTimeout: number;
  private permissionMode: string;

  constructor(config: ClaudeRunnerConfig = {}) {
    this.cliPath = config.cliPath ?? DEFAULT_CLI_PATH;
    this.defaultTimeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    this.permissionMode = config.permissionMode ?? DEFAULT_PERMISSION_MODE;
  }

  /**
   * Run a Claude CLI task to completion.
   *
   * Spawns the CLI as a child process, streams and collects events,
   * and returns the aggregated result. Supports timeout and cancellation.
   */
  async run(task: ClaudeTask): Promise<ClaudeResult> {
    const timeout = task.timeout ?? this.defaultTimeout;
    const events: ClaudeEvent[] = [];
    const textParts: string[] = [];

    return new Promise<ClaudeResult>((resolve) => {
      const args = [
        "--print",
        "--output-format=stream-json",
        `--permission-mode=${this.permissionMode}`,
        "-p",
        task.prompt,
      ];

      log.info(`Spawning Claude CLI: ${this.cliPath} ${args.join(" ").substring(0, 100)}...`);
      log.debug(`Task ${task.id} workdir=${task.workdir}`);

      const child = spawn(this.cliPath, args, {
        cwd: task.workdir,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      this.processes.set(task.id, child);

      const parser = new JsonStreamParser();
      let stderrOutput = "";
      let settled = false;

      const settle = (result: ClaudeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.processes.delete(task.id);
        resolve(result);
      };

      // --- Timeout ---
      const timer = setTimeout(() => {
        log.warn(`Task ${task.id} timed out after ${timeout}ms`);
        this.killProcess(child);
        settle({
          success: false,
          error: `Task timed out after ${timeout}ms`,
          events,
        });
      }, timeout);

      // --- stdout: parse streaming JSON ---
      child.stdout?.on("data", (chunk: Buffer) => {
        const parsed = parser.push(chunk.toString());
        for (const event of parsed) {
          events.push(event);
          if (event.type === "assistant_message" && event.content) {
            textParts.push(event.content);
          }
          task.onEvent?.(event);
        }
      });

      // --- stderr: collect error output ---
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrOutput += chunk.toString();
      });

      // --- Process exit ---
      child.on("close", (code, signal) => {
        // Flush any remaining buffered data
        const remaining = parser.flush();
        for (const event of remaining) {
          events.push(event);
          if (event.type === "assistant_message" && event.content) {
            textParts.push(event.content);
          }
          task.onEvent?.(event);
        }

        const output = textParts.join("");

        if (code === 0) {
          log.info(`Task ${task.id} completed (code=${code})`);
          settle({ success: true, output, events });
        } else {
          const errorMsg = stderrOutput.trim() || `Process exited with code ${code}, signal ${signal}`;
          log.error(`Task ${task.id} failed: ${errorMsg}`);
          settle({ success: false, output, error: errorMsg, events });
        }
      });

      // --- Process error (e.g. ENOENT) ---
      child.on("error", (err) => {
        log.error(`Task ${task.id} spawn error: ${err.message}`);
        settle({
          success: false,
          error: `Failed to spawn Claude CLI: ${err.message}`,
          events,
        });
      });
    });
  }

  /**
   * Cancel a running task by its ID.
   * Sends SIGTERM first, then SIGKILL after a grace period.
   *
   * @returns `true` if the process was found and signalled, `false` otherwise.
   */
  cancel(taskId: string): boolean {
    const child = this.processes.get(taskId);
    if (!child) {
      log.debug(`Cancel requested for unknown task ${taskId}`);
      return false;
    }

    log.info(`Cancelling task ${taskId}`);
    this.killProcess(child);
    return true;
  }

  /** Check whether a task is currently running. */
  isRunning(taskId: string): boolean {
    return this.processes.has(taskId);
  }

  /**
   * Gracefully kill a child process: SIGTERM, then SIGKILL after grace period.
   */
  private killProcess(child: ChildProcess): void {
    try {
      child.kill("SIGTERM");
    } catch {
      // process may already be gone
      return;
    }

    setTimeout(() => {
      try {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      } catch {
        // ignore — process already exited
      }
    }, SIGKILL_DELAY_MS);
  }
}
