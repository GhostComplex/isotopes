import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createBashTool, createLocalBashOperations, type BashOperations } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import type { Executor, SandboxExecutor } from "../middleware/executor.js";

export interface ExecToolOptions {
  cwd?: string;
  /** Used to detect sandboxed agents (and to build `docker exec` argv). */
  executor: Executor;
  /** Required for sandbox agents — undefined means host mode. */
  sandboxExecutor?: SandboxExecutor;
  agentId?: string;
}

export function createExecTool(options: ExecToolOptions): AgentTool {
  const cwd = options.cwd ?? process.cwd();
  const operations = options.sandboxExecutor && options.agentId
    ? createSandboxBashOperations(options.sandboxExecutor, options.agentId)
    : createLocalBashOperations();
  return createBashTool(cwd, { operations });
}

export function createExecTools(options: ExecToolOptions): AgentTool[] {
  return [createExecTool(options)];
}

/**
 * Routes pi's bash tool through SandboxExecutor — the command runs inside the
 * agent's docker container instead of the host. We rebuild `docker exec -i <ctr> sh -c <cmd>`
 * via `buildExecArgv` so we still get a real ChildProcess for stream + abort + timeout.
 */
function createSandboxBashOperations(executor: SandboxExecutor, agentId: string): BashOperations {
  return {
    exec(command, cwd, { onData, signal, timeout, env }) {
      return new Promise((resolve) => {
        let settled = false;
        const settle = (exitCode: number | null): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({ exitCode });
        };

        executor
          .buildExecArgv(agentId, ["sh", "-c", command], { workspacePath: cwd })
          .then((argv) => {
            const child = spawn(argv[0], argv.slice(1), {
              stdio: ["ignore", "pipe", "pipe"],
              ...(env ? { env } : {}),
            });
            child.stdout?.on("data", onData);
            child.stderr?.on("data", onData);
            child.on("error", (err) => {
              onData(Buffer.from(`[sandbox exec error] ${err.message}\n`));
              settle(1);
            });
            child.on("close", (code) => settle(code));

            signal?.addEventListener("abort", () => {
              if (!child.killed) child.kill("SIGTERM");
            });
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            onData(Buffer.from(`[sandbox setup error] ${msg}\n`));
            settle(1);
          });

        const timer = timeout
          ? setTimeout(() => {
              onData(Buffer.from(`\n[command timed out after ${timeout}ms]\n`));
              settle(124);
            }, timeout)
          : undefined;
      });
    },
  };
}
