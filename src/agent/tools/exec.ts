import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "typebox";
import type { Executor } from "../middleware/executor.js";

const DEFAULT_TIMEOUT_SEC = 1800;

export interface ExecToolOptions {
  /** Working directory (host or container). */
  cwd?: string;
  /** Per-agent executor. Required. */
  executor: Executor;
}

function jsonResult(value: unknown): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: undefined };
}

const execSchema = Type.Object({
  command: Type.String({ description: "The shell command to execute" }),
  timeout: Type.Optional(Type.Number({
    description: "Timeout in seconds (default 1800 = 30 min). No upper limit — pass higher values for known-long tasks.",
  })),
});

export function createExecTool(options: ExecToolOptions): AgentTool<typeof execSchema> {
  const cwd = options.cwd ?? process.cwd();
  const { executor } = options;

  return {
    name: "exec",
    label: "exec",
    description:
      "Execute a shell command. Returns stdout, stderr, and exit_code. " +
      "Default timeout: 30 min, no upper limit. " +
      "For long-running commands, use shell backgrounding (`cmd > /tmp/log 2>&1 &`) and `kill <pid>` to manage them.",
    parameters: execSchema,
    execute: async (_id, params: Static<typeof execSchema>) => {
      const { command, timeout: timeoutSec } = params;
      if (!command || command.trim().length === 0) {
        return jsonResult({ error: "Command must not be empty" });
      }

      const argv = ["sh", "-c", command];
      const timeoutMs = (timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;

      try {
        const result = await executor.execute(argv, { workspacePath: cwd, timeout: timeoutMs });
        return jsonResult({
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
          exit_code: result.exitCode,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("timed out")) {
          return jsonResult({
            stdout: "", stderr: "", exit_code: 124,
            error: `Command timed out after ${timeoutMs / 1000}s`,
          });
        }
        return jsonResult({
          stdout: "", stderr: `[exec error] ${msg}`, exit_code: 1,
          error: `Exec failed: ${msg}`,
        });
      }
    },
  };
}

export function createExecTools(options: ExecToolOptions): AgentTool[] {
  return [createExecTool(options)];
}
