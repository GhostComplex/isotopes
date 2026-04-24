// src/daemon/wrapper.ts — Process restart wrapper for isotopes.
// Spawns a child process and restarts it when it exits with code 75.
// Exit code 75 (EX_TEMPFAIL from sysexits.h) is the restart convention
// used by the POST /api/restart endpoint.

import { spawn, type ChildProcess } from "node:child_process";
import { createLogger } from "../core/logger.js";

const log = createLogger("wrapper");

/** Exit code that signals "restart the process". */
const RESTART_EXIT_CODE = 75;

/**
 * Spawn `command` with `args`, inheriting stdio. Returns a promise that
 * resolves with the child's exit code (or 1 on signal kill).
 */
function spawnChild(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(command, args, {
      stdio: "inherit",
      // On Windows, spawn in a shell so .cmd/.bat scripts resolve correctly.
      shell: process.platform === "win32",
    });

    // Forward SIGINT / SIGTERM to the child so it can shut down gracefully.
    const forwardSignal = (signal: NodeJS.Signals) => {
      if (child.pid) {
        child.kill(signal);
      }
    };

    process.on("SIGINT", forwardSignal);
    process.on("SIGTERM", forwardSignal);

    child.on("close", (code, signal) => {
      process.removeListener("SIGINT", forwardSignal);
      process.removeListener("SIGTERM", forwardSignal);

      if (signal) {
        log.info(`Child killed by signal ${signal}`);
        resolve(1);
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

/**
 * Run a command in a restart loop. The child is restarted whenever it exits
 * with code {@link RESTART_EXIT_CODE} (75). Any other exit code stops the loop
 * and is forwarded as this process's exit code.
 */
export async function runWithRestart(command: string, args: string[]): Promise<never> {
  log.info(`Starting: ${command} ${args.join(" ")}`);

  while (true) {
    const exitCode = await spawnChild(command, args);

    if (exitCode === RESTART_EXIT_CODE) {
      log.info("Child exited with code 75 — restarting…");
      continue;
    }

    log.info(`Child exited with code ${exitCode} — stopping.`);
    process.exit(exitCode);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
// Usage: tsx src/daemon/wrapper.ts -- <command> [args...]
// Everything after "--" is treated as the command + arguments to wrap.

function main(): void {
  const separatorIndex = process.argv.indexOf("--");
  if (separatorIndex === -1 || separatorIndex === process.argv.length - 1) {
    console.error("Usage: wrapper.ts -- <command> [args...]");
    process.exit(1);
  }

  const [command, ...args] = process.argv.slice(separatorIndex + 1);
  void runWithRestart(command, args);
}

main();
