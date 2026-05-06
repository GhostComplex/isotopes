import { spawn, type ChildProcess } from "node:child_process";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "typebox";
import { createLogger } from "../../logging/logger.js";
import type { Executor } from "../executor.js";

const log = createLogger("tools:exec");

const DEFAULT_TIMEOUT_SEC = 30;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 100 * 1024;
const DEFAULT_MAX_COMPLETED = 100;

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

export class ProcessRegistry {
  private processes = new Map<string, ProcessInfo>();
  private nextId = 1;
  private maxCompleted: number;

  constructor(options?: { maxCompleted?: number }) {
    this.maxCompleted = options?.maxCompleted ?? DEFAULT_MAX_COMPLETED;
  }

  spawn(command: string, argv: string[], cwd: string): ProcessInfo {
    const id = `proc_${this.nextId++}`;
    const child = spawn(argv[0], argv.slice(1), {
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

  get(id: string): ProcessInfo | undefined {
    return this.processes.get(id);
  }

  list(): ProcessInfo[] {
    return Array.from(this.processes.values());
  }

  kill(id: string): boolean {
    const info = this.processes.get(id);
    if (!info) return false;

    if (info.status === "running") {
      try { info._proc.kill("SIGTERM"); }
      catch { /* may have already exited between check and kill */ }
      info.status = "exited";
      info.exit_code = info.exit_code ?? 137;
    }

    return true;
  }

  clear(): void {
    for (const info of this.processes.values()) {
      if (info.status === "running") {
        try { info._proc.kill("SIGTERM"); } catch { /* ignore */ }
      }
    }
    this.processes.clear();
    this.nextId = 1;
  }

  getCompletedCount(): number {
    let count = 0;
    for (const info of this.processes.values()) {
      if (info.status === "exited") count++;
    }
    return count;
  }

  cleanup(): number {
    const toRemove: string[] = [];
    for (const [id, info] of this.processes.entries()) {
      if (info.status === "exited") toRemove.push(id);
    }
    for (const id of toRemove) this.processes.delete(id);
    return toRemove.length;
  }

  private evictOldestCompleted(): void {
    const completed: Array<{ id: string; startTime: number }> = [];
    for (const [id, info] of this.processes.entries()) {
      if (info.status === "exited") {
        completed.push({ id, startTime: new Date(info.start_time).getTime() });
      }
    }
    if (completed.length <= this.maxCompleted) return;
    completed.sort((a, b) => a.startTime - b.startTime);
    const toRemove = completed.length - this.maxCompleted;
    for (let i = 0; i < toRemove; i++) {
      this.processes.delete(completed[i].id);
      log.debug(`Evicted completed process ${completed[i].id}`);
    }
  }
}

export interface ExecToolOptions {
  /** Working directory (host or container). */
  cwd?: string;
  /** Per-agent executor. Required. */
  executor: Executor;
  registry?: ProcessRegistry;
}

function jsonResult(value: unknown): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: undefined };
}

const execSchema = Type.Object({
  command: Type.String({ description: "The shell command to execute" }),
  timeout: Type.Optional(Type.Number({
    description: "Timeout in seconds (default 30, max 300). Ignored for background processes.",
  })),
  background: Type.Optional(Type.Boolean({
    description: "If true, run the command in the background and return a process_id immediately.",
  })),
});

export function createExecTool(options: ExecToolOptions): AgentTool<typeof execSchema> {
  const cwd = options.cwd ?? process.cwd();
  const registry = options.registry ?? new ProcessRegistry();
  const { executor } = options;

  return {
    name: "exec",
    label: "exec",
    description:
      "Execute a shell command. Returns stdout, stderr, and exit_code. " +
      "Set background=true for long-running processes (returns immediately with process_id). " +
      "Default timeout: 30s, max: 300s.",
    parameters: execSchema,
    execute: async (_id, params: Static<typeof execSchema>) => {
      const { command, timeout: timeoutSec, background } = params;
      if (!command || command.trim().length === 0) {
        return jsonResult({ error: "Command must not be empty" });
      }

      const argv = ["sh", "-c", command];

      if (background) {
        let spawnArgv: string[];
        try {
          spawnArgv = await executor.buildExecArgv(argv, { workspacePath: cwd });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn("buildExecArgv failed for background exec", { command, error: msg });
          return jsonResult({
            stdout: "", stderr: `[exec error] ${msg}`, exit_code: 1,
            error: `Background exec failed: ${msg}`,
          });
        }
        const info = registry.spawn(command, spawnArgv, cwd);
        log.info("Background process started", { processId: info.process_id, command, cwd });
        return jsonResult({
          process_id: info.process_id,
          command: info.command,
          status: "running",
          start_time: info.start_time,
        });
      }

      const timeoutMs = Math.min(
        Math.max((timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000, 1000),
        MAX_TIMEOUT_MS,
      );

      try {
        const result = await executor.execute(argv, { workspacePath: cwd, timeout: timeoutMs });
        log.info("Command executed", { command, cwd, exitCode: result.exitCode });
        return jsonResult({
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
          exit_code: result.exitCode,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("timed out")) {
          log.warn("Command timed out", { command, timeoutMs });
          return jsonResult({
            stdout: "", stderr: "", exit_code: 124,
            error: `Command timed out after ${timeoutMs / 1000}s`,
          });
        }
        log.warn("Exec failed", { command, error: msg });
        return jsonResult({
          stdout: "", stderr: `[exec error] ${msg}`, exit_code: 1,
          error: `Exec failed: ${msg}`,
        });
      }
    },
  };
}

const processListSchema = Type.Object({});

export function createProcessListTool(registry: ProcessRegistry): AgentTool<typeof processListSchema> {
  return {
    name: "process_list",
    label: "process_list",
    description:
      "List all background processes started by the agent. " +
      "Shows process_id, command, status, start_time, and exit_code.",
    parameters: processListSchema,
    execute: async () => {
      const processes = registry.list().map((p) => ({
        process_id: p.process_id,
        command: p.command,
        status: p.status,
        start_time: p.start_time,
        exit_code: p.exit_code,
      }));
      log.info("Process list requested", { count: processes.length });
      return jsonResult({ processes });
    },
  };
}

const processKillSchema = Type.Object({
  process_id: Type.String({ description: "The process_id returned by exec with background=true" }),
});

export function createProcessKillTool(registry: ProcessRegistry): AgentTool<typeof processKillSchema> {
  return {
    name: "process_kill",
    label: "process_kill",
    description:
      "Kill a background process by its process_id. " +
      "Returns success or error if the process is not found.",
    parameters: processKillSchema,
    execute: async (_id, { process_id }) => {
      if (!process_id) return jsonResult({ error: "process_id is required" });
      const info = registry.get(process_id);
      if (!info) return jsonResult({ error: `Process not found: ${process_id}` });
      const wasRunning = info.status === "running";
      registry.kill(process_id);
      log.info("Process killed", { processId: process_id, wasRunning });
      return jsonResult({ success: true, process_id, was_running: wasRunning });
    },
  };
}

export function createExecTools(options: ExecToolOptions): AgentTool[] {
  const registry = options.registry ?? new ProcessRegistry();
  const execOptions = { ...options, registry };
  return [
    createExecTool(execOptions),
    createProcessListTool(registry),
    createProcessKillTool(registry),
  ];
}
