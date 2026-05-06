// macOS-only — assumes the host is darwin. Caller must guard.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../logging/logger.js";

const execAsync = promisify(exec);
const log = createLogger("daemon:launchd");

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

export async function install(config: LaunchAgentConfig): Promise<void> {
  const target = plistPath(config.name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buildPlist(config), "utf-8");
  log.info(`Wrote LaunchAgent plist to ${target}`);

  // unload-then-load so re-install picks up plist changes
  await execAsync(`launchctl unload -w ${target}`).catch(() => undefined);
  await execAsync(`launchctl load -w ${target}`);
  log.info(`Loaded LaunchAgent ${config.name}`);
}

export async function uninstall(name: string): Promise<void> {
  const target = plistPath(name);
  await execAsync(`launchctl unload -w ${target}`).catch((err) => {
    log.debug("Could not unload agent before uninstall (may not be loaded):", err);
  });
  await fs.unlink(target);
  log.info(`Removed LaunchAgent plist ${target}`);
}

// SIGTERM the daemon; KeepAlive=true makes launchd respawn with a new PID.
export async function restart(name: string): Promise<void> {
  await execAsync(`launchctl stop ${name}`);
  log.info(`Restarted LaunchAgent ${name}`);
}

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
  log.warn(`Unexpected launchctl list output for ${name}: ${stdout.trim()}`);
  return { state: "loaded" };
}
