// src/daemon/service.ts — System service integration (launchd / systemd / schtasks)
// Generates and installs service definitions so the daemon starts at boot.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../core/logger.js";

const execAsync = promisify(exec);
const log = createLogger("daemon:service");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Detected operating system platform for service integration. */
export type ServicePlatform = "macos" | "linux" | "windows" | "unsupported";

/** Configuration for installing the daemon as a system service. */
export interface ServiceConfig {
  /** Reverse-domain identifier, e.g. "ai.isotopes.daemon" */
  name: string;
  description: string;
  /** Absolute path to the node executable */
  execPath: string;
  /** Absolute path to the CLI entry point (dist/cli.js) */
  cliPath: string;
  /** Absolute path to the config file */
  configPath: string;
  /** Absolute path to the log file */
  logPath: string;
  /** User to run the service as (systemd only) */
  user?: string;
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

/** Detect the current operating system for service integration. */
export function getPlatform(): ServicePlatform {
  switch (os.platform()) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "unsupported";
  }
}

// ---------------------------------------------------------------------------
// launchd helpers (macOS)
// ---------------------------------------------------------------------------

function launchdPlistPath(name: string): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${name}.plist`);
}

function buildPlist(config: ServiceConfig): string {
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

// ---------------------------------------------------------------------------
// systemd helpers (Linux)
// ---------------------------------------------------------------------------

function systemdUnitDir(): string {
  return path.join(os.homedir(), ".config", "systemd", "user");
}

function systemdUnitPath(name: string): string {
  return path.join(systemdUnitDir(), `${name}.service`);
}

function buildUnit(config: ServiceConfig): string {
  return `[Unit]
Description=${config.description}
After=network.target

[Service]
Type=simple
ExecStart=${config.execPath} ${config.cliPath}
Environment=ISOTOPES_DAEMON=1
Restart=on-failure
RestartSec=5
StandardOutput=append:${config.logPath}
StandardError=append:${config.logPath}

[Install]
WantedBy=default.target
`;
}

// ---------------------------------------------------------------------------
// schtasks helpers (Windows)
// ---------------------------------------------------------------------------

const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

function assertSafeName(name: string): void {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid service name "${name}" — only alphanumeric, dot, dash, and underscore are allowed`,
    );
  }
}

function assertSafePath(p: string): void {
  if (/["&|<>^%]/.test(p)) {
    throw new Error(
      `Path contains unsafe characters for shell interpolation: ${p}`,
    );
  }
}

function schtasksTaskName(name: string): string {
  return `\\${name}`;
}

function buildCmdScript(config: ServiceConfig): string {
  assertSafePath(config.execPath);
  assertSafePath(config.cliPath);
  return `@echo off\r\nset ISOTOPES_DAEMON=1\r\n"${config.execPath}" "${config.cliPath}"\r\n`;
}

function schtasksCmdScriptPath(name: string): string {
  return path.join(os.homedir(), ".isotopes", `${name}.cmd`);
}

// ---------------------------------------------------------------------------
// ServiceManager
// ---------------------------------------------------------------------------

/**
 * ServiceManager — installs and manages the daemon as a system service.
 *
 * Supports macOS launchd (plist), Linux systemd (user unit), and Windows
 * Task Scheduler (schtasks). Provides install, uninstall, enable, disable,
 * and status-check operations.
 */
export class ServiceManager {
  private platform: ServicePlatform;

  constructor() {
    this.platform = getPlatform();
  }

  // -------------------------------------------------------------------------
  // Install / uninstall
  // -------------------------------------------------------------------------

  async install(config: ServiceConfig): Promise<void> {
    assertSafeName(config.name);
    if (this.platform === "unsupported") {
      throw new Error(
        `Service installation is not supported on ${os.platform()}`,
      );
    }

    if (this.platform === "macos") {
      const plistPath = launchdPlistPath(config.name);
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.writeFile(plistPath, buildPlist(config), "utf-8");
      log.info(`Wrote launchd plist to ${plistPath}`);
    } else if (this.platform === "linux") {
      const unitPath = systemdUnitPath(config.name);
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(unitPath, buildUnit(config), "utf-8");
      await execAsync("systemctl --user daemon-reload");
      log.info(`Wrote systemd unit to ${unitPath}`);
    } else {
      // Windows: write a .cmd launcher script, then register a scheduled task
      const scriptPath = schtasksCmdScriptPath(config.name);
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(scriptPath, buildCmdScript(config), "utf-8");

      const taskName = schtasksTaskName(config.name);
      try {
        await execAsync(
          `schtasks /Create /F /SC ONLOGON /RL LIMITED /TN "${taskName}" /TR "\\"${scriptPath}\\""`,
        );
      } catch {
        // Fallback: place script in Startup folder if schtasks fails (e.g. restricted env)
        const startupDir = path.join(
          process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
          "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
        );
        const startupPath = path.join(startupDir, `${config.name}.cmd`);
        await fs.mkdir(startupDir, { recursive: true });
        await fs.writeFile(startupPath, buildCmdScript(config), "utf-8");
        log.warn(`schtasks failed; placed startup script at ${startupPath}`);
        return;
      }

      await execAsync(`schtasks /Run /TN "${taskName}"`).catch(() => {
        log.debug("schtasks /Run failed — task will start at next logon");
      });
      log.info(`Registered scheduled task ${taskName}`);
    }
  }

  async uninstall(name: string): Promise<void> {
    assertSafeName(name);
    if (this.platform === "unsupported") {
      throw new Error(
        `Service management is not supported on ${os.platform()}`,
      );
    }

    // Disable first (best-effort)
    try {
      await this.disable(name);
    } catch (err) {
      log.debug(`Could not disable service before uninstall (may not be enabled):`, err);
    }

    if (this.platform === "macos") {
      const plistPath = launchdPlistPath(name);
      await fs.unlink(plistPath);
      log.info(`Removed launchd plist ${plistPath}`);
    } else if (this.platform === "linux") {
      const unitPath = systemdUnitPath(name);
      await fs.unlink(unitPath);
      await execAsync("systemctl --user daemon-reload");
      log.info(`Removed systemd unit ${unitPath}`);
    } else {
      const taskName = schtasksTaskName(name);
      await execAsync(`schtasks /Delete /F /TN "${taskName}"`).catch(() => {
        log.debug("schtasks /Delete failed — task may not exist");
      });

      // Remove .cmd script
      try {
        await fs.unlink(schtasksCmdScriptPath(name));
      } catch { /* may not exist */ }

      // Remove startup folder fallback if present
      const startupDir = path.join(
        process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
        "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
      );
      try {
        await fs.unlink(path.join(startupDir, `${name}.cmd`));
      } catch { /* may not exist */ }

      log.info(`Removed scheduled task ${taskName}`);
    }
  }

  // -------------------------------------------------------------------------
  // Enable / disable
  // -------------------------------------------------------------------------

  async enable(name: string): Promise<void> {
    if (this.platform === "macos") {
      await execAsync(`launchctl load -w ${launchdPlistPath(name)}`);
      log.info(`Enabled launchd service ${name}`);
    } else if (this.platform === "linux") {
      await execAsync(`systemctl --user enable ${name}`);
      log.info(`Enabled systemd service ${name}`);
    } else if (this.platform === "windows") {
      const taskName = schtasksTaskName(name);
      await execAsync(`schtasks /Change /TN "${taskName}" /ENABLE`);
      log.info(`Enabled scheduled task ${taskName}`);
    } else {
      throw new Error(
        `Service management is not supported on ${os.platform()}`,
      );
    }
  }

  async disable(name: string): Promise<void> {
    if (this.platform === "macos") {
      await execAsync(`launchctl unload -w ${launchdPlistPath(name)}`);
      log.info(`Disabled launchd service ${name}`);
    } else if (this.platform === "linux") {
      await execAsync(`systemctl --user disable ${name}`);
      log.info(`Disabled systemd service ${name}`);
    } else if (this.platform === "windows") {
      const taskName = schtasksTaskName(name);
      await execAsync(`schtasks /Change /TN "${taskName}" /DISABLE`);
      log.info(`Disabled scheduled task ${taskName}`);
    } else {
      throw new Error(
        `Service management is not supported on ${os.platform()}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  async isInstalled(name: string): Promise<boolean> {
    if (this.platform === "macos") {
      try {
        await fs.access(launchdPlistPath(name));
        return true;
      } catch {
        return false;
      }
    } else if (this.platform === "linux") {
      try {
        await fs.access(systemdUnitPath(name));
        return true;
      } catch {
        return false;
      }
    } else if (this.platform === "windows") {
      try {
        await execAsync(`schtasks /Query /TN "${schtasksTaskName(name)}"`);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}
