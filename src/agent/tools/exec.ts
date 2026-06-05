import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createBashTool, createLocalBashOperations, type BashOperations } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import type { Executor } from "../middleware/executor.js";

export interface ExecToolOptions {
  cwd?: string;
  executor: Executor;
  /**
   * Sandbox mode: route pi's bash tool through `executor.buildExecArgv` + self-spawn
   * so the command runs inside the agent's docker container.
   * Host mode: use pi's `createLocalBashOperations` for cross-platform shell resolution.
   */
  isSandboxed?: boolean;
}

export function createExecTool(options: ExecToolOptions): AgentTool {
  const cwd = options.cwd ?? process.cwd();
  const operations = options.isSandboxed
    ? createSandboxBashOperations(options.executor)
    : createLocalBashOperations();
  return createBashTool(cwd, { operations });
}

export function createExecTools(options: ExecToolOptions): AgentTool[] {
  return [createExecTool(options)];
}

/**
 * Adapt pi's BashOperations to any Executor — we ask the executor for the
 * argv it would spawn (e.g. `docker exec -i <ctr> sh -c <cmd>`) and spawn it
 * ourselves so we control stream / abort / timeout.
 */
function createSandboxBashOperations(executor: Executor): BashOperations {
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
          .buildExecArgv(["sh", "-c", command], { workspacePath: cwd })
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
