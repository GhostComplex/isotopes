// src/daemon/wrapper.ts — Process wrapper that restarts on exit code 75
// Used by `dev:watch` to provide graceful restart via the REST API.
//
// Convention: exit code 75 (EX_TEMPFAIL) signals "restart me".
// Any other exit code (including 0) stops the wrapper.

import { spawn } from "node:child_process";
import { createLogger } from "../core/logger.js";

const log = createLogger("daemon:wrapper");

/** Exit code that signals "restart the child process". */
export const RESTART_EXIT_CODE = 75;

/** Maximum rapid restarts before the wrapper gives up. */
const MAX_RAPID_RESTARTS = 5;

/** Time window (ms) for counting rapid restarts. */
const RAPID_RESTART_WINDOW = 10_000;

/**
 * Spawn a child process and return a promise that resolves with its exit code.
 */
function spawnChild(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  log.info(`Starting: ${argv.join(" ")}`);

  const child = spawn(cmd, args, {
    stdio: "inherit",
    env: process.env,
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        log.warn(`Child killed by signal ${signal}`);
        resolve(1);
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

/**
 * Run the wrapper loop. Restarts the child on exit code 75, stops otherwise.
 *
 * @param argv - The command and arguments to run (e.g. `["tsx", "src/cli.ts"]`)
 */
export async function runWrapper(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    log.error("No command specified");
    process.exit(1);
  }

  const restartTimestamps: number[] = [];

   
  while (true) {
    const code = await spawnChild(argv);

    if (code !== RESTART_EXIT_CODE) {
      log.info(`Child exited with code ${code} — stopping wrapper`);
      process.exit(code);
    }

    // Track rapid restarts to prevent infinite crash loops
    const now = Date.now();
    restartTimestamps.push(now);

    // Discard timestamps outside the window
    while (restartTimestamps.length > 0 && restartTimestamps[0] < now - RAPID_RESTART_WINDOW) {
      restartTimestamps.shift();
    }

    if (restartTimestamps.length > MAX_RAPID_RESTARTS) {
      log.error(
        `Too many restarts (${restartTimestamps.length}) within ${RAPID_RESTART_WINDOW / 1000}s — aborting`,
      );
      process.exit(1);
    }

    log.info("Child requested restart (exit code 75) — restarting...");
  }
}

// ---------------------------------------------------------------------------
// CLI entry point — pass everything after `--` as the child command
// Usage: tsx src/daemon/wrapper.ts -- tsx src/cli.ts [args...]
// ---------------------------------------------------------------------------

const dashDash = process.argv.indexOf("--");
if (dashDash !== -1) {
  const childArgv = process.argv.slice(dashDash + 1);
  runWrapper(childArgv).catch((err) => {
    log.error("Wrapper failed:", err);
    process.exit(1);
  });
} else if (
  // Also support: tsx src/daemon/wrapper.ts tsx src/cli.ts
  process.argv.length > 2 &&
  !process.argv[2].startsWith("-")
) {
  runWrapper(process.argv.slice(2)).catch((err) => {
    log.error("Wrapper failed:", err);
    process.exit(1);
  });
}
