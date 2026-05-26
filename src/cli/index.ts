#!/usr/bin/env node

import { parseArgs } from "node:util";
import { VERSION } from "../utils/version.js";
import { loadConfig } from "../config.js";
import { enableFileLogging } from "../logging/logger.js";
import { createRuntime } from "../app.js";
import { getConfigPath, getLogsDir } from "../paths.js";

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
    lines: { type: "string" },
    level: { type: "string" },
    follow: { type: "boolean", short: "f" },
    force: { type: "boolean" },
  },
  allowPositionals: true,
});

const HELP_TEXT = `Isotopes v${VERSION}

Usage:
  isotopes                           Run in foreground (default)
  isotopes init [--force]            Write a default ~/.isotopes/isotopes.yaml

  isotopes tui [--agent id]          Interactive TUI chat with an agent

  isotopes cron list                 List scheduled jobs
  isotopes cron add <name> <expr> <agent> <task>
                                     Add a cron job
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
  --lines          Number of log lines (default: 50)
  --level          Filter logs by level (debug/info/warn/error)
  -f, --follow     Follow log output

Config: ~/.isotopes/isotopes.yaml

Environment:
  ISOTOPES_HOME   Override home directory (default: ~/.isotopes)
  DEBUG=true      Enable debug logging
`;

if (values.help) {
  console.log(HELP_TEXT);
  process.exit(0);
}

if (values.version) {
  console.log(`Isotopes v${VERSION}`);
  process.exit(0);
}

async function main() {
  if (process.stdout.isTTY) enableFileLogging(getLogsDir());
  const configPath = values.config ?? getConfigPath();
  const config = await loadConfig(configPath);

  const runtime = await createRuntime({ config });

  console.log("Running... Press Ctrl+C to stop");

  const onSignal = async () => {
    await runtime.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run(): Promise<void> {
  switch (subcommand) {
    case "init": {
      const { handleInitCommand } = await import("./init.js");
      await handleInitCommand(values.force ?? false);
      break;
    }

    case "service": {
      const { handleServiceCommand } = await import("./service.js");
      await handleServiceCommand(subArgs);
      break;
    }

    case "tui": {
      const { launchTui } = await import("../tui/index.js");
      await launchTui({ agent: values.agent });
      break;
    }

    case "cron": {
      const { handleCronCommand } = await import("./cron.js");
      await handleCronCommand(positionals);
      break;
    }

    case "logs": {
      const { handleLogsCommand } = await import("./logs.js");
      await handleLogsCommand({
        lines: values.lines ? parseInt(String(values.lines), 10) : 50,
        level: values.level as string | undefined,
        follow: values.follow ?? false,
      });
      break;
    }

    case undefined:
      await main();
      break;

    default:
      console.error(`Unknown command: ${subcommand}`);
      console.log(HELP_TEXT);
      process.exit(1);
  }
}

run().catch((error) => {
  console.error(`Fatal error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
