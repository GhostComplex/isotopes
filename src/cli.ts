#!/usr/bin/env node
// src/cli.ts — Isotopes CLI entry point
// Start agents from configuration file, with daemon lifecycle commands.

import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { VERSION } from "./version.js";
import { loadConfig } from "./core/config.js";
import { logger } from "./core/logger.js";
import { createRuntime } from "./core/runtime.js";
import {
  getConfigPath,
  getIsotopesHome,
  getLogsDir,
} from "./core/paths.js";
import { DaemonProcess } from "./daemon/process.js";
import { ServiceManager, getPlatform, type ServiceConfig } from "./daemon/service.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVICE_NAME = "ai.isotopes.daemon";
const SERVICE_DESCRIPTION = "Isotopes AI Agent Daemon";

// ---------------------------------------------------------------------------
// Daemon helpers
// ---------------------------------------------------------------------------

function getApiPort(): number {
  return process.env.ISOTOPES_PORT ? parseInt(process.env.ISOTOPES_PORT, 10) : 2712;
}

function makeDaemon(configPath?: string): DaemonProcess {
  const home = getIsotopesHome();
  return new DaemonProcess({
    configPath: configPath ?? getConfigPath(),
    logDir: getLogsDir(),
    pidFile: path.join(home, "isotopes.pid"),
  });
}

function makeServiceConfig(): ServiceConfig {
  return {
    name: SERVICE_NAME,
    description: SERVICE_DESCRIPTION,
    execPath: process.argv[0],
    cliPath: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "cli.js",
    ),
    configPath: getConfigPath(),
    logPath: path.join(getLogsDir(), "isotopes.out.log"),
  };
}

// ---------------------------------------------------------------------------
// CLI argument parsing – positional subcommands
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const subcommand = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
const subArgs = subcommand ? args.slice(1) : args;

const { values, positionals } = parseArgs({
  args: subArgs,
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    config: { type: "string", short: "c" },
    agent: { type: "string" },
    json: { type: "boolean" },
    message: { type: "string" },
    lines: { type: "string" },
    level: { type: "string" },
    follow: { type: "boolean", short: "f" },
    force: { type: "boolean" },
  },
  allowPositionals: true,
});

// ---------------------------------------------------------------------------
// Help & version
// ---------------------------------------------------------------------------

const HELP_TEXT = `
Isotopes v${VERSION}

Usage:
  isotopes                           Run in foreground (default)
  isotopes init [--force]            Write a default ~/.isotopes/isotopes.yaml
  isotopes start [--config path]     Start as background daemon
  isotopes stop                      Stop the running daemon
  isotopes status                    Show daemon status
  isotopes restart [--config path]   Restart the daemon
  isotopes reload [agentId]          Reload workspace (hot-reload)

  isotopes tui [--agent id] [--message "text"]
                                     Interactive TUI chat with an agent

  isotopes sessions list             List all sessions
  isotopes sessions show <id>        Show session details
  isotopes sessions delete <id>      Delete a session
  isotopes sessions reset <id>       Reset session history

  isotopes cron list                 List scheduled jobs
  isotopes cron add <spec> <task>    Add a cron job
  isotopes cron remove <id>          Remove a cron job
  isotopes cron enable <id>          Enable a job
  isotopes cron disable <id>         Disable a job
  isotopes cron run <id>             Run a job now

  isotopes logs [--lines N] [--level LEVEL] [-f]
                                     View daemon logs

  isotopes service install           Install as system service
  isotopes service uninstall         Remove system service
  isotopes service enable            Enable service (auto-start)
  isotopes service disable           Disable service

Options:
  -h, --help       Show this help
  -v, --version    Show version
  -c, --config     Path to config file
  --agent          Agent ID for tui command
  --message        Send an initial message in TUI mode
  --json           Output as JSON (sessions, cron commands)
  --lines          Number of log lines (default: 50)
  --level          Filter logs by level (debug/info/warn/error)
  -f, --follow     Follow log output

Config: ~/.isotopes/isotopes.yaml

Environment:
  ISOTOPES_HOME   Override home directory (default: ~/.isotopes)
  LOG_LEVEL       Set log level (debug/info/warn/error)
  DEBUG=isotopes  Enable debug logging
`;

if (values.help) {
  console.log(HELP_TEXT);
  process.exit(0);
}

if (values.version) {
  console.log(`Isotopes v${VERSION}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Subcommand dispatch
// ---------------------------------------------------------------------------

async function handleDaemonCommand(): Promise<void> {
  const daemon = makeDaemon(values.config);

  switch (subcommand) {
    case "start": {
      const { pid } = await daemon.start();
      console.log(`Isotopes daemon started (pid ${pid})`);
      break;
    }

    case "stop": {
      await daemon.stop();
      console.log("Isotopes daemon stopped");
      break;
    }

    case "status": {
      const s = await daemon.status();
      const useJson = subArgs.includes("--json");

      if (!s.running) {
        if (useJson) {
          console.log(JSON.stringify({ running: false }));
        } else {
          console.log("Isotopes daemon is not running");
        }
        break;
      }

      // Fetch extended status from REST API
      let apiStatus: {
        version?: string;
        uptime?: number;
        sessions?: number;
        cronJobs?: number;
        agents?: string[];
      } = {};

      try {
        const port = getApiPort();
        const res = await fetch(`http://127.0.0.1:${port}/api/status`);
        if (res.ok) {
          apiStatus = (await res.json()) as typeof apiStatus;
        }
      } catch {
        // API not reachable — continue with daemon-only info
      }

      // Try to get agent list from config
      let agents: string[] = [];
      try {
        const port = getApiPort();
        const res = await fetch(`http://127.0.0.1:${port}/api/config`);
        if (res.ok) {
          const cfg = (await res.json()) as { agents?: { id: string }[] };
          agents = cfg.agents?.map((a) => a.id) ?? [];
        }
      } catch {
        // ignore
      }

      if (useJson) {
        console.log(
          JSON.stringify({
            running: true,
            pid: s.pid,
            startedAt: s.startedAt?.toISOString(),
            uptime: s.uptime,
            configPath: s.configPath,
            version: apiStatus.version,
            sessions: apiStatus.sessions ?? 0,
            cronJobs: apiStatus.cronJobs ?? 0,
            agents,
          })
        );
      } else {
        console.log(`Isotopes daemon is running`);
        console.log(`  PID:        ${s.pid}`);
        if (apiStatus.version) console.log(`  Version:    ${apiStatus.version}`);
        if (s.startedAt) console.log(`  Started:    ${s.startedAt.toISOString()}`);
        if (s.uptime !== undefined) console.log(`  Uptime:     ${formatUptime(s.uptime)}`);
        if (s.configPath) console.log(`  Config:     ${s.configPath}`);
        if (agents.length > 0) console.log(`  Agents:     ${agents.join(", ")}`);
        console.log(`  Sessions:   ${apiStatus.sessions ?? 0}`);
        console.log(`  Cron jobs:  ${apiStatus.cronJobs ?? 0}`);
      }
      break;
    }

    case "restart": {
      const { pid } = await daemon.restart();
      console.log(`Isotopes daemon restarted (pid ${pid})`);
      break;
    }

    default:
      console.error(`Unknown command: ${subcommand}`);
      console.log(HELP_TEXT);
      process.exit(1);
  }
}

async function handleServiceCommand(): Promise<void> {
  const serviceSubcommand = subArgs[0];
  const svc = new ServiceManager();

  switch (serviceSubcommand) {
    case "install": {
      const platform = getPlatform();
      if (platform === "unsupported") {
        console.error(`Service installation is not supported on this platform`);
        process.exit(1);
      }
      const config = makeServiceConfig();
      await svc.install(config);
      console.log(`Service "${SERVICE_NAME}" installed (${platform})`);
      break;
    }

    case "uninstall": {
      await svc.uninstall(SERVICE_NAME);
      console.log(`Service "${SERVICE_NAME}" removed`);
      break;
    }

    case "enable": {
      await svc.enable(SERVICE_NAME);
      console.log(`Service "${SERVICE_NAME}" enabled`);
      break;
    }

    case "disable": {
      await svc.disable(SERVICE_NAME);
      console.log(`Service "${SERVICE_NAME}" disabled`);
      break;
    }

    default:
      console.error(
        `Unknown service command: ${serviceSubcommand ?? "(none)"}\n` +
          `Usage: isotopes service install|uninstall|enable|disable`,
      );
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Sessions command
// ---------------------------------------------------------------------------

async function handleSessionsCommand(): Promise<void> {
  const subCmd = positionals[0];
  const sessionId = positionals[1];
  const port = getApiPort();

  try {
    switch (subCmd) {
      case "list":
      case undefined: {
        const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const sessions = await res.json() as Array<{ id: string; agentId: string; messageCount?: number; createdAt?: string }>;
        if (values.json) {
          console.log(JSON.stringify(sessions, null, 2));
        } else {
          if (sessions.length === 0) {
            console.log("No active sessions");
          } else {
            console.log(`Sessions (${sessions.length}):\n`);
            for (const s of sessions) {
              console.log(`  ${s.id}`);
              console.log(`    Agent: ${s.agentId}`);
              console.log(`    Messages: ${s.messageCount ?? "?"}`);
              console.log(`    Created: ${s.createdAt ?? "?"}`);
              console.log();
            }
          }
        }
        break;
      }
      case "show": {
        if (!sessionId) {
          console.error("Usage: isotopes sessions show <id>");
          process.exit(1);
        }
        const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}`);
        if (!res.ok) {
          if (res.status === 404) {
            console.error(`Session not found: ${sessionId}`);
          } else {
            throw new Error(`API error: ${res.status}`);
          }
          process.exit(1);
        }
        const session = await res.json() as { id: string; agentId: string; messageCount?: number; createdAt?: string };
        if (values.json) {
          console.log(JSON.stringify(session, null, 2));
        } else {
          console.log(`Session: ${session.id}`);
          console.log(`  Agent: ${session.agentId}`);
          console.log(`  Messages: ${session.messageCount ?? "?"}`);
          console.log(`  Created: ${session.createdAt ?? "?"}`);
        }
        break;
      }
      case "delete": {
        if (!sessionId) {
          console.error("Usage: isotopes sessions delete <id>");
          process.exit(1);
        }
        const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          if (res.status === 404) {
            console.error(`Session not found: ${sessionId}`);
          } else {
            throw new Error(`API error: ${res.status}`);
          }
          process.exit(1);
        }
        console.log(`Session deleted: ${sessionId}`);
        break;
      }
      case "reset": {
        if (!sessionId) {
          console.error("Usage: isotopes sessions reset <id>");
          process.exit(1);
        }
        const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/reset`, {
          method: "POST",
        });
        if (!res.ok) {
          if (res.status === 404) {
            console.error(`Session not found: ${sessionId}`);
          } else {
            throw new Error(`API error: ${res.status}`);
          }
          process.exit(1);
        }
        console.log(`Session reset: ${sessionId}`);
        break;
      }
      default:
        console.error(`Unknown sessions subcommand: ${subCmd}`);
        console.error("Usage: isotopes sessions [list|show|delete|reset] [id]");
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof TypeError && String(err).includes("fetch")) {
      console.error("Cannot connect to daemon. Is it running? Try: isotopes start");
    } else {
      console.error("Error:", err instanceof Error ? err.message : err);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Cron command
// ---------------------------------------------------------------------------

async function handleCronCommand(): Promise<void> {
  const subCmd = positionals[0];
  const port = getApiPort();

  try {
    switch (subCmd) {
      case "list":
      case undefined: {
        const res = await fetch(`http://127.0.0.1:${port}/api/cron`);
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const jobs = await res.json() as Array<{ id: string; schedule: string; agentId: string; enabled: boolean; lastRun?: string; nextRun?: string }>;
        if (values.json) {
          console.log(JSON.stringify(jobs, null, 2));
        } else {
          if (jobs.length === 0) {
            console.log("No cron jobs configured");
          } else {
            console.log(`Cron Jobs (${jobs.length}):\n`);
            for (const j of jobs) {
              const status = j.enabled ? "enabled" : "disabled";
              console.log(`  ${j.id} [${status}]`);
              console.log(`    Schedule: ${j.schedule}`);
              console.log(`    Agent: ${j.agentId}`);
              if (j.lastRun) console.log(`    Last run: ${j.lastRun}`);
              if (j.nextRun) console.log(`    Next run: ${j.nextRun}`);
              console.log();
            }
          }
        }
        break;
      }
      case "add": {
        const schedule = positionals[1];
        const task = positionals.slice(2).join(" ");
        if (!schedule || !task) {
          console.error("Usage: isotopes cron add <schedule> <task>");
          console.error('Example: isotopes cron add "0 9 * * *" "Send daily summary"');
          process.exit(1);
        }
        const res = await fetch(`http://127.0.0.1:${port}/api/cron`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ schedule, task }),
        });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const job = await res.json() as { id: string };
        console.log(`Cron job created: ${job.id}`);
        break;
      }
      case "remove": {
        const jobId = positionals[1];
        if (!jobId) {
          console.error("Usage: isotopes cron remove <id>");
          process.exit(1);
        }
        const res = await fetch(`http://127.0.0.1:${port}/api/cron/${jobId}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          if (res.status === 404) {
            console.error(`Job not found: ${jobId}`);
          } else {
            throw new Error(`API error: ${res.status}`);
          }
          process.exit(1);
        }
        console.log(`Cron job removed: ${jobId}`);
        break;
      }
      case "enable": {
        const jobId = positionals[1];
        if (!jobId) {
          console.error("Usage: isotopes cron enable <id>");
          process.exit(1);
        }
        const res = await fetch(`http://127.0.0.1:${port}/api/cron/${jobId}/enable`, {
          method: "POST",
        });
        if (!res.ok) {
          if (res.status === 404) {
            console.error(`Job not found: ${jobId}`);
          } else {
            throw new Error(`API error: ${res.status}`);
          }
          process.exit(1);
        }
        console.log(`Cron job enabled: ${jobId}`);
        break;
      }
      case "disable": {
        const jobId = positionals[1];
        if (!jobId) {
          console.error("Usage: isotopes cron disable <id>");
          process.exit(1);
        }
        const res = await fetch(`http://127.0.0.1:${port}/api/cron/${jobId}/disable`, {
          method: "POST",
        });
        if (!res.ok) {
          if (res.status === 404) {
            console.error(`Job not found: ${jobId}`);
          } else {
            throw new Error(`API error: ${res.status}`);
          }
          process.exit(1);
        }
        console.log(`Cron job disabled: ${jobId}`);
        break;
      }
      case "run": {
        const jobId = positionals[1];
        if (!jobId) {
          console.error("Usage: isotopes cron run <id>");
          process.exit(1);
        }
        const res = await fetch(`http://127.0.0.1:${port}/api/cron/${jobId}/run`, {
          method: "POST",
        });
        if (!res.ok) {
          if (res.status === 404) {
            console.error(`Job not found: ${jobId}`);
          } else {
            throw new Error(`API error: ${res.status}`);
          }
          process.exit(1);
        }
        console.log(`Cron job triggered: ${jobId}`);
        break;
      }
      default:
        console.error(`Unknown cron subcommand: ${subCmd}`);
        console.error("Usage: isotopes cron [list|add|remove|enable|disable|run] [args]");
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof TypeError && String(err).includes("fetch")) {
      console.error("Cannot connect to daemon. Is it running? Try: isotopes start");
    } else {
      console.error("Error:", err instanceof Error ? err.message : err);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Logs command
// ---------------------------------------------------------------------------

async function handleLogsCommand(): Promise<void> {
  const logsDir = getLogsDir();
  const logFile = path.join(logsDir, "isotopes.log");
  const lines = values.lines ? parseInt(String(values.lines), 10) : 50;
  const level = values.level as string | undefined;
  const follow = values.follow ?? false;

  // Check if log file exists
  const fsPromises = await import("node:fs/promises");
  try {
    await fsPromises.access(logFile);
  } catch {
    console.error(`Log file not found: ${logFile}`);
    console.error("Is the daemon running? Try: isotopes start");
    process.exit(1);
  }

  // Filter function
  const matchesLevel = (line: string): boolean => {
    if (!level) return true;
    const levelUpper = level.toUpperCase();
    // Match common log formats: [INFO], INFO:, level=info, etc.
    return line.toUpperCase().includes(levelUpper);
  };

  if (follow) {
    // Follow mode: poll file for new content (fs.watchFile is more reliable
    // than fs.watch for append-only log files, especially on network FS).
    const nodeFs = await import("node:fs");
    let position = (await fsPromises.stat(logFile)).size;
    let reading = false;
    let trailingFragment = "";

    const readNew = () => {
      if (reading) return;
      // Handle log rotation: if file shrank, reset to beginning
      let currentSize: number;
      try {
        currentSize = nodeFs.statSync(logFile).size;
      } catch {
        return;
      }
      if (currentSize < position) position = 0;
      if (currentSize === position) return;

      reading = true;
      const readStart = position;
      position = currentSize;

      const stream = nodeFs.createReadStream(logFile, { start: readStart, end: currentSize - 1, encoding: "utf-8" });
      let buf = "";
      stream.on("data", (chunk: string | Buffer) => { buf += String(chunk); });
      stream.on("end", () => {
        reading = false;
        const text = trailingFragment + buf;
        const parts = text.split("\n");
        trailingFragment = parts.pop() ?? "";
        for (const line of parts) {
          if (line && matchesLevel(line)) {
            console.log(line);
          }
        }
      });
      stream.on("error", () => { reading = false; });
    };

    nodeFs.watchFile(logFile, { interval: 500 }, () => readNew());

    process.on("SIGINT", () => {
      nodeFs.unwatchFile(logFile);
      process.exit(0);
    });
  } else {
    // Read last N lines
    const content = await fsPromises.readFile(logFile, "utf-8");
    const allLines = content.split("\n").filter(Boolean);
    const filtered = level ? allLines.filter(matchesLevel) : allLines;
    const lastN = filtered.slice(-lines);

    for (const line of lastN) {
      console.log(line);
    }
  }
}

// ---------------------------------------------------------------------------
// Main – foreground run (original behaviour)
// ---------------------------------------------------------------------------

async function main() {
  const configPath = values.config ?? getConfigPath();
  logger.info(`Loading config from ${configPath}`);
  const config = await loadConfig(configPath);
  logger.info(`Loaded ${config.agents.length} agent(s)`);


  const runtime = await createRuntime({ config, apiPort: getApiPort() });

  logger.info("Running... Press Ctrl+C to stop");

  const onSignal = async () => {
    await runtime.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

// ---------------------------------------------------------------------------
// init — write default config
// ---------------------------------------------------------------------------

async function handleInitCommand(): Promise<void> {
  const home = getIsotopesHome();
  const configPath = getConfigPath();
  await fs.mkdir(home, { recursive: true });

  const exists = await fs
    .stat(configPath)
    .then(() => true)
    .catch(() => false);

  if (exists && !values.force) {
    console.error(`Config already exists: ${configPath}`);
    console.error(`Re-run with --force to overwrite.`);
    process.exit(1);
  }

  const { runInitWizard } = await import("./init/wizard.js");
  const { renderConfig } = await import("./init/render.js");
  const answers = await runInitWizard();
  const yaml = renderConfig(answers);

  await fs.writeFile(configPath, yaml, "utf-8");
  console.log(`Wrote config to ${configPath}`);
  console.log(``);
  console.log(`Next:`);
  if (answers.llm === "skip") {
    console.log(`  • Edit ${configPath} and configure a provider`);
  }
  console.log(`  • isotopes        # run in foreground`);
  console.log(`  • isotopes tui    # interactive TUI`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  switch (subcommand) {
    case "init":
      await handleInitCommand();
      break;

    case "start":
    case "stop":
    case "status":
    case "restart":
      await handleDaemonCommand();
      break;

    case "service":
      await handleServiceCommand();
      break;

    case "tui": {
      const { launchTui } = await import("./tui/index.js");
      await launchTui({ agent: values.agent, config: values.config, message: values.message });
      break;
    }

    case "sessions":
      await handleSessionsCommand();
      break;

    case "cron":
      await handleCronCommand();
      break;

    case "logs":
      await handleLogsCommand();
      break;

    case undefined:
      // No subcommand → run in foreground (original behaviour)
      await main();
      break;

    default:
      console.error(`Unknown command: ${subcommand}`);
      console.log(HELP_TEXT);
      process.exit(1);
  }
}

run().catch((error) => {
  logger.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
