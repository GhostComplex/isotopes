// src/daemon/service.ts — System service integration (launchd / systemd)
// Generates and installs service definitions so the daemon starts at boot.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../core/logger.js";

const execAsync = promisify(execCb);
const log = createLogger("daemon:service");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServicePlatform = "macos" | "linux" | "unsupported";

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

export function getPlatform(): ServicePlatform {
  switch (os.platform()) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
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
// ServiceManager
// ---------------------------------------------------------------------------

export class ServiceManager {
  private platform: ServicePlatform;

  constructor() {
    this.platform = getPlatform();
  }

  // -------------------------------------------------------------------------
  // Install / uninstall
  // -------------------------------------------------------------------------

  async install(config: ServiceConfig): Promise<void> {
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
    } else {
      const unitPath = systemdUnitPath(config.name);
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(unitPath, buildUnit(config), "utf-8");
      await execAsync("systemctl --user daemon-reload");
      log.info(`Wrote systemd unit to ${unitPath}`);
    }
  }

  async uninstall(name: string): Promise<void> {
    if (this.platform === "unsupported") {
      throw new Error(
        `Service management is not supported on ${os.platform()}`,
      );
    }

    // Disable first (best-effort)
    try {
      await this.disable(name);
    } catch {
      // may not be enabled
    }

    if (this.platform === "macos") {
      const plistPath = launchdPlistPath(name);
      await fs.unlink(plistPath);
      log.info(`Removed launchd plist ${plistPath}`);
    } else {
      const unitPath = systemdUnitPath(name);
      await fs.unlink(unitPath);
      await execAsync("systemctl --user daemon-reload");
      log.info(`Removed systemd unit ${unitPath}`);
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
    }
    return false;
  }
}
