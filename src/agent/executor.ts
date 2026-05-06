export interface ExecResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  /** True iff stdout or stderr was capped at EXEC_MAX_OUTPUT_BYTES. */
  truncated?: boolean;
}

export interface ExecOptions {
  /** Working directory. Sandbox honors at container-create time, not per-call. */
  workspacePath?: string;
  /** Hard deadline in ms; rejects on expiry. */
  timeout?: number;
  stdin?: Buffer | string;
}

/**
 * Per-agent command execution. HostExecutor runs on the host process;
 * SandboxExecutor.bind(agentId) runs inside the agent's container.
 * Tools take an Executor and don't know which backend they got.
 */
export interface Executor {
  execute(argv: string[], opts?: ExecOptions): Promise<ExecResult>;

  /**
   * Returns the host-side argv to spawn for this command. HostExecutor
   * returns argv as-is; SandboxExecutor prepends `docker exec -i <ctr>`.
   * Used by background-process tracking — caller spawns the returned argv
   * itself so it can keep the ChildProcess handle.
   */
  buildExecArgv(argv: string[], opts?: ExecOptions): Promise<string[]>;
}
