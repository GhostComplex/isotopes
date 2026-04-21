// src/daemon/process.ts — Daemon process lifecycle management
// Handles starting, stopping, and querying the Isotopes daemon process.

import { spawn, execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../core/logger.js";

const log = createLogger("daemon:process");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Runtime status snapshot of the daemon process. */
export interface DaemonStatus {
  running: boolean;
  pid?: number;
  uptime?: number; // seconds
  startedAt?: Date;
  configPath?: string;
}

/** Options for starting the daemon (config path, log directory, PID file). */
export interface DaemonOptions {
  configPath: string;
  logDir: string;
  pidFile: string;
}

// ---------------------------------------------------------------------------
// PID file helpers
// ---------------------------------------------------------------------------

/** Read PID from pidfile; returns undefined if missing or invalid. */
async function readPid(pidFile: string): Promise<number | undefined> {
  try {
    const raw = await fs.readFile(pidFile, "utf-8");
    const pid = parseInt(raw.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Write PID to pidfile, creating parent directories as needed. */
async function writePid(pidFile: string, pid: number): Promise<void> {
  await fs.mkdir(path.dirname(pidFile), { recursive: true });
  await fs.writeFile(pidFile, String(pid), "utf-8");
}

/** Remove pidfile (best-effort). */
async function removePid(pidFile: string): Promise<void> {
  try {
    await fs.unlink(pidFile);
  } catch {
    // ignore – file may already be gone
  }
}

/** Terminate a process by PID. On Windows uses taskkill (tree kill); without
 *  force it omits /F to allow graceful shutdown, with force it adds /F. */
function killProcess(pid: number, force = false): void {
  if (process.platform === "win32") {
    try {
      const flags = force ? "/F /T" : "/T";
      execSync(`taskkill ${flags} /PID ${pid}`, { stdio: "ignore" });
    } catch {
      // Exit code 128 = process not found (already exited) — acceptable.
      // Permission errors will surface via the isProcessAlive poll timeout.
    }
  } else {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read the start timestamp we stash next to the PID file. */
async function readStartTime(pidFile: string): Promise<Date | undefined> {
  try {
    const raw = await fs.readFile(pidFile + ".started", "utf-8");
    const d = new Date(raw.trim());
    return isNaN(d.getTime()) ? undefined : d;
  } catch {
    return undefined;
  }
}

/** Persist the daemon start timestamp. */
async function writeStartTime(pidFile: string, date: Date): Promise<void> {
  await fs.writeFile(pidFile + ".started", date.toISOString(), "utf-8");
}

/** Remove start-time file (best-effort). */
async function removeStartTime(pidFile: string): Promise<void> {
  try {
    await fs.unlink(pidFile + ".started");
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// DaemonProcess
// ---------------------------------------------------------------------------

/**
 * DaemonProcess — manages the Isotopes daemon as a detached child process.
 *
 * Handles starting (with PID file tracking), graceful stopping (SIGTERM
 * then SIGKILL), status queries, and restart. Log output is redirected
 * to files in the configured log directory.
 */
export class DaemonProcess {
  constructor(private options: DaemonOptions) {}

  /**
   * Start the daemon as a detached child process.
   * Resolves with the child PID.
   * Throws if a daemon is already running.
   */
  async start(): Promise<{ pid: number }> {
    if (await this.isRunning()) {
      const existing = await readPid(this.options.pidFile);
      throw new Error(`Daemon already running (pid ${existing})`);
    }

    // Ensure log directory exists
    await fs.mkdir(this.options.logDir, { recursive: true });

    const outLog = path.join(this.options.logDir, "isotopes.out.log");
    const errLog = path.join(this.options.logDir, "isotopes.err.log");

    const outFd = await fs.open(outLog, "a");
    const errFd = await fs.open(errLog, "a");

    // Resolve the CLI entry point.  When running from source the file next to
    // this module is `../cli.ts` – but the published build will have
    // `../cli.js`.  We pass `process.argv[0]` (node/tsx) as the executable and
    // the CLI file as its first argument so that `tsx` works transparently
    // during development.
    const cliEntry = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "cli.js",
    );

    const child = spawn(process.argv[0], [cliEntry], {
      detached: true,
      stdio: ["ignore", outFd.fd, errFd.fd],
      // Set cwd to user home to avoid inheriting caller's cwd.
      // Without this, file tools with workspaceOnly=false resolve relative
      // paths against the caller's cwd, which may be another agent's workspace,
      // causing identity contamination (#92).
      cwd: os.homedir(),
      env: {
        ...process.env,
        ISOTOPES_DAEMON: "1",
      },
    });

    const pid = child.pid;
    if (pid === undefined) {
      throw new Error("Failed to start daemon: no PID returned");
    }

    child.unref();

    // Persist PID and start timestamp
    const now = new Date();
    await writePid(this.options.pidFile, pid);
    await writeStartTime(this.options.pidFile, now);

    // Close log file descriptors in *this* process – the child inherited them
    await outFd.close();
    await errFd.close();

    log.info(`Daemon started (pid ${pid})`);
    return { pid };
  }

  /**
   * Stop the running daemon.  Sends SIGTERM first, waits up to 5 s, then
   * escalates to SIGKILL.
   */
  async stop(): Promise<void> {
    const pid = await readPid(this.options.pidFile);
    if (pid === undefined || !isProcessAlive(pid)) {
      await removePid(this.options.pidFile);
      await removeStartTime(this.options.pidFile);
      throw new Error("Daemon is not running");
    }

    // Graceful stop
    killProcess(pid);

    // Wait for exit (poll every 100 ms, max 5 s)
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) {
        await removePid(this.options.pidFile);
        await removeStartTime(this.options.pidFile);
        log.info(`Daemon stopped (pid ${pid})`);
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    // Force kill
    try {
      killProcess(pid, true);
    } catch {
      // already gone
    }
    await removePid(this.options.pidFile);
    await removeStartTime(this.options.pidFile);
    log.warn(`Daemon force-killed (pid ${pid})`);
  }

  /**
   * Return the current daemon status.
   */
  async status(): Promise<DaemonStatus> {
    const pid = await readPid(this.options.pidFile);
    if (pid === undefined || !isProcessAlive(pid)) {
      // Clean up stale pidfile
      if (pid !== undefined) {
        await removePid(this.options.pidFile);
        await removeStartTime(this.options.pidFile);
      }
      return { running: false };
    }

    const startedAt = await readStartTime(this.options.pidFile);
    const uptime =
      startedAt !== undefined
        ? Math.floor((Date.now() - startedAt.getTime()) / 1_000)
        : undefined;

    return {
      running: true,
      pid,
      uptime,
      startedAt,
      configPath: this.options.configPath,
    };
  }

  /**
   * Restart the daemon (stop then start).
   */
  async restart(): Promise<{ pid: number }> {
    try {
      await this.stop();
    } catch {
      // daemon may not be running – that's fine
    }
    return this.start();
  }

  /**
   * Quick check: is the daemon process alive?
   */
  async isRunning(): Promise<boolean> {
    const pid = await readPid(this.options.pidFile);
    return pid !== undefined && isProcessAlive(pid);
  }
}
