// macOS-only — assumes the host is darwin. Caller must guard.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../logging/logger.js";

const execAsync = promisify(exec);
const log = createLogger("daemon:launchd");

/** Configuration for installing the daemon as a LaunchAgent. */
export interface LaunchAgentConfig {
  /** Reverse-domain identifier, e.g. "ai.isotopes.daemon" */
  name: string;
  /** Absolute path to the node executable */
  execPath: string;
  /** Absolute path to the CLI entry script */
  cliPath: string;
  /** Absolute path to the log file (used for both stdout and stderr) */
  logPath: string;
}

/** Status snapshot returned by {@link status}. */
export type LaunchAgentStatus =
  | { state: "running"; pid: number }
  | { state: "loaded" }
  | { state: "not-installed" };

function plistPath(name: string): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${name}.plist`);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildPlist(config: LaunchAgentConfig): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(config.name)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(config.execPath)}</string>
    <string>${xmlEscape(config.cliPath)}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${xmlEscape(config.logPath)}</string>

  <key>StandardErrorPath</key>
  <string>${xmlEscape(config.logPath)}</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

/**
 * Write the plist and hand it to launchd. Idempotent: if the agent is
 * already loaded, unload-then-load to pick up any plist changes.
 */
export async function install(config: LaunchAgentConfig): Promise<void> {
  const target = plistPath(config.name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buildPlist(config), "utf-8");
  log.info(`Wrote LaunchAgent plist to ${target}`);

  // Best-effort unload (silent if not loaded) then load — makes install idempotent
  // and ensures launchd picks up plist changes on re-install.
  await execAsync(`launchctl unload -w ${target}`).catch(() => undefined);
  await execAsync(`launchctl load -w ${target}`);
  log.info(`Loaded LaunchAgent ${config.name}`);
}

/** Unload the agent (best-effort) and delete the plist file. */
export async function uninstall(name: string): Promise<void> {
  const target = plistPath(name);
  await execAsync(`launchctl unload -w ${target}`).catch((err) => {
    log.debug("Could not unload agent before uninstall (may not be loaded):", err);
  });
  await fs.unlink(target);
  log.info(`Removed LaunchAgent plist ${target}`);
}

/**
 * Send SIGTERM to the running daemon. With KeepAlive=true, launchd
 * immediately respawns it — net effect is a restart with a new PID.
 * Throws if the agent isn't loaded.
 */
export async function restart(name: string): Promise<void> {
  await execAsync(`launchctl stop ${name}`);
  log.info(`Restarted LaunchAgent ${name}`);
}

/**
 * Query launchctl for the agent's current state.
 * - `running`: loaded and process is alive (pid > 0)
 * - `loaded`: loaded but no live process (transient — KeepAlive should respawn)
 * - `not-installed`: launchctl doesn't know about this label
 */
export async function status(name: string): Promise<LaunchAgentStatus> {
  let stdout: string;
  try {
    ({ stdout } = await execAsync(`launchctl list ${name}`));
  } catch {
    return { state: "not-installed" };
  }
  const firstField = stdout.trim().split(/\s+/)[0];
  if (firstField === "-") return { state: "loaded" };
  const pid = Number.parseInt(firstField, 10);
  if (Number.isFinite(pid) && pid > 0) return { state: "running", pid };
  return { state: "loaded" };
}
