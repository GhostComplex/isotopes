#!/usr/bin/env node

import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { VERSION } from "./version.js";
import { loadConfig } from "../config.js";
import { logger } from "../logging/logger.js";
import { createRuntime } from "../app.js";
import {
  getConfigPath,
  getIsotopesHome,
  getLogsDir,
} from "../paths.js";
import * as launchd from "../daemon/launchd.js";
import type { LaunchAgentConfig } from "../daemon/launchd.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVICE_NAME = "ai.isotopes.daemon";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getApiPort(): number {
  return process.env.ISOTOPES_PORT ? parseInt(process.env.ISOTOPES_PORT, 10) : 2712;
}

function makeServiceConfig(): LaunchAgentConfig {
  return {
    name: SERVICE_NAME,
    execPath: process.argv[0],
    cliPath: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js"),
    logPath: path.join(getLogsDir(), "isotopes.out.log"),
  };
}

function requireMacOS(): void {
  if (process.platform !== "darwin") {
    console.error("`isotopes service` is macOS-only. Run isotopes in the foreground or supervise it yourself on this platform.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(public status: number) {
    super(`API error: ${status}`);
  }
}

async function apiCall<T = unknown>(
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${getApiPort()}${apiPath}`, init);
  if (!res.ok) throw new ApiError(res.status);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

function requireArg(value: string | undefined, usage: string): string {
  if (!value) {
    console.error(`Usage: ${usage}`);
    process.exit(1);
  }
  return value;
}

async function withDaemonErrors(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof TypeError && String(err).includes("fetch")) {
      console.error("Cannot connect to daemon. Is it running? Run `isotopes` in the foreground or via the LaunchAgent.");
    } else {
      console.error("Error:", err instanceof Error ? err.message : err);
    }
    process.exit(1);
  }
}

async function apiAction(opts: {
  method: string;
  path: string;
  body?: unknown;
  notFoundLabel: string;
  notFoundId: string;
  success: string;
}): Promise<void> {
  try {
    await apiCall(opts.method, opts.path, opts.body);
    console.log(opts.success);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      console.error(`${opts.notFoundLabel} not found: ${opts.notFoundId}`);
      process.exit(1);
    }
    throw err;
  }
}

function printJsonOr(data: unknown, fallback: () => void): void {
  if (values.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    fallback();
  }
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

  isotopes tui [--agent id]          Interactive TUI chat with an agent

  isotopes cron list                 List scheduled jobs
  isotopes cron add <spec> <task>    Add a cron job
  isotopes cron remove <id>          Remove a cron job
  isotopes cron enable <id>          Enable a job
  isotopes cron disable <id>         Disable a job
  isotopes cron run <id>             Run a job now

  isotopes logs [--lines N] [--level LEVEL] [-f]
                                     View daemon logs

  isotopes service install           Install + start as macOS LaunchAgent
  isotopes service uninstall         Stop + remove the LaunchAgent
  isotopes service restart           Restart the LaunchAgent (read new config / binary)
  isotopes service status            Show LaunchAgent status

Options:
  -h, --help       Show this help
  -v, --version    Show version
  -c, --config     Path to config file
  --agent          Agent ID for tui command
  --json           Output as JSON (cron commands)
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

async function handleServiceCommand(): Promise<void> {
  requireMacOS();
  const serviceSubcommand = subArgs[0];

  switch (serviceSubcommand) {
    case "install":
      await launchd.install(makeServiceConfig());
      console.log(`LaunchAgent "${SERVICE_NAME}" installed and running`);
      break;

    case "uninstall":
      await launchd.uninstall(SERVICE_NAME);
      console.log(`LaunchAgent "${SERVICE_NAME}" removed`);
      break;

    case "restart":
      await launchd.restart(SERVICE_NAME);
      console.log(`LaunchAgent "${SERVICE_NAME}" restarted`);
      break;

    case "status": {
      const s = await launchd.status(SERVICE_NAME);
      switch (s.state) {
        case "running":
          console.log(`Running (pid ${s.pid})`);
          break;
        case "loaded":
          console.log("Loaded but no live process — KeepAlive should respawn shortly");
          break;
        case "not-installed":
          console.log("Not installed");
          break;
      }
      break;
    }

    default:
      console.error(
        `Unknown service command: ${serviceSubcommand ?? "(none)"}\n` +
          `Usage: isotopes service install|uninstall|restart|status`,
      );
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Sessions command
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cron command
// ---------------------------------------------------------------------------

type CronJob = {
  id: string;
  schedule: string;
  agentId: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
};

async function cronJobAction(
  verb: "remove" | "enable" | "disable" | "run",
): Promise<void> {
  const id = requireArg(positionals[1], `isotopes cron ${verb} <id>`);
  const spec = {
    remove: { method: "DELETE", path: `/api/cron/${id}`, success: `Cron job removed: ${id}` },
    enable: { method: "POST", path: `/api/cron/${id}/enable`, success: `Cron job enabled: ${id}` },
    disable: { method: "POST", path: `/api/cron/${id}/disable`, success: `Cron job disabled: ${id}` },
    run: { method: "POST", path: `/api/cron/${id}/run`, success: `Cron job triggered: ${id}` },
  }[verb];
  await apiAction({ ...spec, notFoundLabel: "Job", notFoundId: id });
}

async function handleCronCommand(): Promise<void> {
  const subCmd = positionals[0];

  await withDaemonErrors(async () => {
    switch (subCmd) {
      case "list":
      case undefined: {
        const jobs = await apiCall<CronJob[]>("GET", "/api/cron");
        printJsonOr(jobs, () => {
          if (jobs.length === 0) {
            console.log("No cron jobs configured");
            return;
          }
          console.log(`Cron Jobs (${jobs.length}):\n`);
          for (const j of jobs) {
            console.log(`  ${j.id} [${j.enabled ? "enabled" : "disabled"}]`);
            console.log(`    Schedule: ${j.schedule}`);
            console.log(`    Agent: ${j.agentId}`);
            if (j.lastRun) console.log(`    Last run: ${j.lastRun}`);
            if (j.nextRun) console.log(`    Next run: ${j.nextRun}`);
            console.log();
          }
        });
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
        const job = await apiCall<{ id: string }>("POST", "/api/cron", { schedule, task });
        console.log(`Cron job created: ${job.id}`);
        break;
      }
      case "remove":
      case "enable":
      case "disable":
      case "run":
        await cronJobAction(subCmd);
        break;
      default:
        console.error(`Unknown cron subcommand: ${subCmd}`);
        console.error("Usage: isotopes cron [list|add|remove|enable|disable|run] [args]");
        process.exit(1);
    }
  });
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
    console.error("Has the daemon ever run? Run `isotopes` in the foreground first.");
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

  const { runInitWizard } = await import("../init/wizard.js");
  const { renderConfig } = await import("../init/render.js");
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

    case "service":
      await handleServiceCommand();
      break;

    case "tui": {
      const { launchTui } = await import("../tui/index.js");
      await launchTui({ agent: values.agent });
      break;
    }

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
