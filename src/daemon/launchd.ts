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

function plistPath(name: string): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${name}.plist`);
}

function buildPlist(config: LaunchAgentConfig): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${config.name}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${config.execPath}</string>
    <string>${config.cliPath}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>ISOTOPES_DAEMON</key>
    <string>1</string>
  </dict>

  <key>RunAtLoad</key>
  <false/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${config.logPath}</string>

  <key>StandardErrorPath</key>
  <string>${config.logPath}</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

/** Write the LaunchAgent plist into ~/Library/LaunchAgents. */
export async function install(config: LaunchAgentConfig): Promise<void> {
  const target = plistPath(config.name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buildPlist(config), "utf-8");
  log.info(`Wrote LaunchAgent plist to ${target}`);
}

/** Remove the LaunchAgent plist (best-effort disable first). */
export async function uninstall(name: string): Promise<void> {
  try {
    await disable(name);
  } catch (err) {
    log.debug("Could not disable agent before uninstall (may not be loaded):", err);
  }
  await fs.unlink(plistPath(name));
  log.info(`Removed LaunchAgent plist ${plistPath(name)}`);
}

/** Load the agent (`launchctl load -w`). */
export async function enable(name: string): Promise<void> {
  await execAsync(`launchctl load -w ${plistPath(name)}`);
  log.info(`Enabled LaunchAgent ${name}`);
}

/** Unload the agent (`launchctl unload -w`). */
export async function disable(name: string): Promise<void> {
  await execAsync(`launchctl unload -w ${plistPath(name)}`);
  log.info(`Disabled LaunchAgent ${name}`);
}

/** True iff the plist file exists in ~/Library/LaunchAgents. */
export async function isInstalled(name: string): Promise<boolean> {
  try {
    await fs.access(plistPath(name));
    return true;
  } catch {
    return false;
  }
}
