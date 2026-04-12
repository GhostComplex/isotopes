// src/tools/exec.ts — Shell execution and background process management tools
// Provides exec (with background mode), process_list, and process_kill tools.

import { spawn, type ChildProcess } from "node:child_process";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../core/logger.js";
import type { Tool } from "../core/types.js";
import type { ToolHandler } from "../core/tools.js";

const execAsync = promisify(exec);
const log = createLogger("tools:exec");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for foreground exec in seconds. */
const DEFAULT_TIMEOUT_SEC = 30;

/** Maximum allowed timeout in milliseconds. */
const MAX_TIMEOUT_MS = 300_000;

/** Maximum output size in bytes (100 KB). */
const MAX_OUTPUT_BYTES = 100 * 1024;

// ---------------------------------------------------------------------------
// ProcessRegistry — tracks background processes
// ---------------------------------------------------------------------------

export interface ProcessInfo {
  process_id: string;
  command: string;
  status: "running" | "exited";
  start_time: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  /** Internal reference to the child process (not serialised). */
  _proc: ChildProcess;
}

/** Default maximum number of completed processes to retain. */
const DEFAULT_MAX_COMPLETED = 100;

/**
 * ProcessRegistry — singleton that tracks background processes spawned by
 * the exec tool. Each agent workspace gets its own registry instance.
 *
 * Automatically evicts oldest completed processes when maxCompleted is exceeded
 * to prevent unbounded memory growth (#296).
 */
export class ProcessRegistry {
  private processes = new Map<string, ProcessInfo>();
  private nextId = 1;
  private maxCompleted: number;

  constructor(options?: { maxCompleted?: number }) {
    this.maxCompleted = options?.maxCompleted ?? DEFAULT_MAX_COMPLETED;
  }

  /** Spawn a background process and register it. */
  spawn(command: string, cwd: string): ProcessInfo {
    const id = `proc_${this.nextId++}`;

    const child = spawn("sh", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    const info: ProcessInfo = {
      process_id: id,
      command,
      status: "running",
      start_time: new Date().toISOString(),
      exit_code: null,
      stdout: "",
      stderr: "",
      _proc: child,
    };

    // Capture output (truncated to MAX_OUTPUT_BYTES)
    child.stdout?.on("data", (chunk: Buffer) => {
      if (info.stdout.length < MAX_OUTPUT_BYTES) {
        info.stdout += chunk.toString().slice(0, MAX_OUTPUT_BYTES - info.stdout.length);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (info.stderr.length < MAX_OUTPUT_BYTES) {
        info.stderr += chunk.toString().slice(0, MAX_OUTPUT_BYTES - info.stderr.length);
      }
    });

    child.on("exit", (code) => {
      info.status = "exited";
      info.exit_code = code ?? 1;
      this.evictOldestCompleted();
    });

    child.on("error", (err) => {
      info.status = "exited";
      info.exit_code = 1;
      info.stderr += `\n[spawn error] ${err.message}`;
      this.evictOldestCompleted();
    });

    this.processes.set(id, info);
    return info;
  }

  /** Get a process by ID. */
  get(id: string): ProcessInfo | undefined {
    return this.processes.get(id);
  }

  /** List all tracked processes. */
  list(): ProcessInfo[] {
    return Array.from(this.processes.values());
  }

  /** Kill a process by ID. Returns true if killed, false if not found. */
  kill(id: string): boolean {
    const info = this.processes.get(id);
    if (!info) return false;

    if (info.status === "running") {
      try {
        info._proc.kill("SIGTERM");
      } catch {
        // Process may have already exited between status check and kill
      }
      info.status = "exited";
      info.exit_code = info.exit_code ?? 137;
    }

    return true;
  }

  /** Clear all processes (for testing). */
  clear(): void {
    for (const info of this.processes.values()) {
      if (info.status === "running") {
        try {
          info._proc.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }
    this.processes.clear();
    this.nextId = 1;
  }

  /** Get count of completed (exited) processes. */
  getCompletedCount(): number {
    let count = 0;
    for (const info of this.processes.values()) {
      if (info.status === "exited") count++;
    }
    return count;
  }

  /** Manually remove all completed processes. */
  cleanup(): number {
    const toRemove: string[] = [];
    for (const [id, info] of this.processes.entries()) {
      if (info.status === "exited") {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      this.processes.delete(id);
    }
    return toRemove.length;
  }

  /**
   * Evict oldest completed processes if count exceeds maxCompleted.
   * Called automatically when a process exits.
   */
  private evictOldestCompleted(): void {
    const completed: Array<{ id: string; startTime: number }> = [];
    for (const [id, info] of this.processes.entries()) {
      if (info.status === "exited") {
        completed.push({ id, startTime: new Date(info.start_time).getTime() });
      }
    }

    if (completed.length <= this.maxCompleted) return;

    // Sort by start time (oldest first)
    completed.sort((a, b) => a.startTime - b.startTime);

    // Remove oldest until we're at maxCompleted
    const toRemove = completed.length - this.maxCompleted;
    for (let i = 0; i < toRemove; i++) {
      this.processes.delete(completed[i].id);
      log.debug(`Evicted completed process ${completed[i].id}`);
    }
  }
}

// ---------------------------------------------------------------------------
// exec tool
// ---------------------------------------------------------------------------

export interface ExecToolOptions {
  /** Working directory for command execution. */
  cwd?: string;
  /** ProcessRegistry instance for background process tracking. */
  registry?: ProcessRegistry;
}

/**
 * Create the `exec` tool.
 *
 * Execute shell commands with configurable timeout.
 * Supports `background: true` for long-running processes.
 */
export function createExecTool(
  options: ExecToolOptions = {},
): { tool: Tool; handler: ToolHandler } {
  const { cwd = process.cwd() } = options;
  const registry = options.registry ?? new ProcessRegistry();

  return {
    tool: {
      name: "exec",
      description:
        "Execute a shell command. Returns stdout, stderr, and exit_code. " +
        "Set background=true for long-running processes (returns immediately with process_id). " +
        "Default timeout: 30s, max: 300s.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
          timeout: {
            type: "number",
            description:
              "Timeout in seconds (default 30, max 300). Ignored for background processes.",
          },
          background: {
            type: "boolean",
            description:
              "If true, run the command in the background and return a process_id immediately.",
          },
        },
        required: ["command"],
      },
    },
    handler: async (args) => {
      const {
        command,
        timeout: timeoutSec,
        background,
      } = args as {
        command: string;
        timeout?: number;
        background?: boolean;
      };

      if (!command || command.trim().length === 0) {
        return JSON.stringify({ error: "Command must not be empty" });
      }

      // Background mode — spawn and return immediately
      if (background) {
        const info = registry.spawn(command, cwd);

        log.info("Background process started", {
          processId: info.process_id,
          command,
          cwd,
        });

        return JSON.stringify({
          process_id: info.process_id,
          command: info.command,
          status: "running",
          start_time: info.start_time,
        });
      }

      // Foreground mode — run with timeout
      const timeoutMs = Math.min(
        Math.max((timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000, 1000),
        MAX_TIMEOUT_MS,
      );

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout: timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
        });

        log.info("Command executed", { command, cwd, exitCode: 0 });

        return JSON.stringify({
          stdout: stdout || "",
          stderr: stderr || "",
          exit_code: 0,
        });
      } catch (error) {
        const err = error as {
          message?: string;
          code?: number;
          signal?: string;
          stdout?: string;
          stderr?: string;
        };

        if (err.signal === "SIGTERM") {
          log.warn("Command timed out", { command, timeoutMs });
          return JSON.stringify({
            stdout: err.stdout || "",
            stderr: err.stderr || "",
            exit_code: 124,
            error: `Command timed out after ${timeoutMs / 1000}s`,
          });
        }

        const exitCode = typeof err.code === "number" ? err.code : 1;
        log.info("Command failed", { command, exitCode });

        return JSON.stringify({
          stdout: err.stdout || "",
          stderr: err.stderr || "",
          exit_code: exitCode,
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// process_list tool
// ---------------------------------------------------------------------------

/**
 * Create the `process_list` tool.
 *
 * Lists all background processes started by the agent.
 */
export function createProcessListTool(
  registry: ProcessRegistry,
): { tool: Tool; handler: ToolHandler } {
  return {
    tool: {
      name: "process_list",
      description:
        "List all background processes started by the agent. " +
        "Shows process_id, command, status, start_time, and exit_code.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    handler: async () => {
      const processes = registry.list().map((p) => ({
        process_id: p.process_id,
        command: p.command,
        status: p.status,
        start_time: p.start_time,
        exit_code: p.exit_code,
      }));

      log.info("Process list requested", { count: processes.length });

      return JSON.stringify({ processes });
    },
  };
}

// ---------------------------------------------------------------------------
// process_kill tool
// ---------------------------------------------------------------------------

/**
 * Create the `process_kill` tool.
 *
 * Kills a background process by process_id.
 */
export function createProcessKillTool(
  registry: ProcessRegistry,
): { tool: Tool; handler: ToolHandler } {
  return {
    tool: {
      name: "process_kill",
      description:
        "Kill a background process by its process_id. " +
        "Returns success or error if the process is not found.",
      parameters: {
        type: "object",
        properties: {
          process_id: {
            type: "string",
            description: "The process_id returned by exec with background=true",
          },
        },
        required: ["process_id"],
      },
    },
    handler: async (args) => {
      const { process_id } = args as { process_id: string };

      if (!process_id) {
        return JSON.stringify({ error: "process_id is required" });
      }

      const info = registry.get(process_id);
      if (!info) {
        return JSON.stringify({ error: `Process not found: ${process_id}` });
      }

      const wasRunning = info.status === "running";
      registry.kill(process_id);

      log.info("Process killed", {
        processId: process_id,
        wasRunning,
      });

      return JSON.stringify({
        success: true,
        process_id,
        was_running: wasRunning,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create all exec/process tools with a shared ProcessRegistry.
 * Returns an array of tool+handler pairs ready for registration.
 */
export function createExecTools(
  options: ExecToolOptions = {},
): { tool: Tool; handler: ToolHandler }[] {
  const registry = options.registry ?? new ProcessRegistry();
  const execOptions = { ...options, registry };

  return [
    createExecTool(execOptions),
    createProcessListTool(registry),
    createProcessKillTool(registry),
  ];
}
