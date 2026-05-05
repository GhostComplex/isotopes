import { spawn } from "node:child_process";
import type { Executor, ExecOptions, ExecResult } from "./executor.js";

const EXEC_MAX_OUTPUT_BYTES = 100 * 1024;

/**
 * Runs commands in the host process. Used for non-sandboxed agents.
 * Thin wrapper over child_process.spawn — host = trust model.
 */
export class HostExecutor implements Executor {
  async execute(argv: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (argv.length === 0) {
      return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("argv is empty") };
    }

    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd: opts?.workspacePath,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;

      const collect = (chunks: Buffer[], chunk: Buffer, getBytes: () => number, setBytes: (n: number) => void, setTruncated: (b: boolean) => void): void => {
        const bytes = getBytes();
        if (bytes >= EXEC_MAX_OUTPUT_BYTES) { setTruncated(true); return; }
        if (bytes + chunk.length > EXEC_MAX_OUTPUT_BYTES) {
          chunks.push(chunk.subarray(0, EXEC_MAX_OUTPUT_BYTES - bytes));
          setBytes(EXEC_MAX_OUTPUT_BYTES);
          setTruncated(true);
        } else {
          chunks.push(chunk);
          setBytes(bytes + chunk.length);
        }
      };

      child.stdout?.on("data", (chunk: Buffer) =>
        collect(stdoutChunks, chunk, () => stdoutBytes, (n) => { stdoutBytes = n; }, (b) => { stdoutTruncated = b; }));
      child.stderr?.on("data", (chunk: Buffer) =>
        collect(stderrChunks, chunk, () => stderrBytes, (n) => { stderrBytes = n; }, (b) => { stderrTruncated = b; }));

      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      if (opts?.timeout) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          reject(new Error(`Host execution timed out after ${opts.timeout}ms`));
        }, opts.timeout);
      }

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        if (timedOut) return;  // already rejected by timer
        const truncMarker = Buffer.from(`\n[output truncated at ${EXEC_MAX_OUTPUT_BYTES} bytes]`, "utf8");
        const stdout = stdoutTruncated ? Buffer.concat([...stdoutChunks, truncMarker]) : Buffer.concat(stdoutChunks);
        const stderr = stderrTruncated ? Buffer.concat([...stderrChunks, truncMarker]) : Buffer.concat(stderrChunks);
        resolve({
          exitCode: code ?? 0,
          stdout,
          stderr,
          ...(stdoutTruncated || stderrTruncated ? { truncated: true } : {}),
        });
      });

      if (opts?.stdin !== undefined) {
        child.stdin?.end(opts.stdin);
      } else {
        child.stdin?.end();
      }
    });
  }

  async buildExecArgv(argv: string[]): Promise<string[]> {
    return argv;
  }
}
