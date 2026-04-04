#!/usr/bin/env node
// src/cli.ts — Isotopes CLI entry point
// Start agents from configuration file.

import path from "node:path";
import { parseArgs } from "node:util";
import { VERSION } from "./index.js";
import { loadConfig, loadConfigFromDir, toAgentConfig, getDiscordToken } from "./core/config.js";
import { PiMonoCore } from "./core/pi-mono.js";
import { DefaultAgentManager } from "./core/agent-manager.js";
import { DefaultSessionStore } from "./core/session-store.js";
import { DiscordTransport } from "./transports/discord.js";
import { logger } from "./core/logger.js";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values, positionals } = parseArgs({
  options: {
    config: { type: "string", short: "c" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
  allowPositionals: true,
});

// ---------------------------------------------------------------------------
// Help & version
// ---------------------------------------------------------------------------

if (values.help) {
  console.log(`
Isotopes v${VERSION}

Usage: isotopes [options] [config-dir]

Options:
  -c, --config <file>  Path to config file (yaml/json)
  -h, --help           Show this help
  -v, --version        Show version

Examples:
  isotopes                    # Load isotopes.yaml from current dir
  isotopes ./my-project       # Load from directory
  isotopes -c config.yaml     # Load specific file
`);
  process.exit(0);
}

if (values.version) {
  console.log(`Isotopes v${VERSION}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Determine config source
  let config;
  if (values.config) {
    config = await loadConfig(values.config);
  } else {
    const dir = positionals[0] || process.cwd();
    config = await loadConfigFromDir(dir);
  }

  logger.info(`Loaded ${config.agents.length} agent(s)`);

  // Initialize core
  const core = new PiMonoCore();
  const agentManager = new DefaultAgentManager(core);

  // Create agents
  for (const agentFile of config.agents) {
    const agentConfig = toAgentConfig(agentFile, config.provider);

    // Resolve workspace path relative to config
    if (agentConfig.workspacePath && !path.isAbsolute(agentConfig.workspacePath)) {
      agentConfig.workspacePath = path.resolve(
        positionals[0] || process.cwd(),
        agentConfig.workspacePath,
      );
    }

    await agentManager.create(agentConfig);
    logger.info(`Created agent: ${agentConfig.id}`);
  }

  // Initialize session store
  const dataDir = path.join(positionals[0] || process.cwd(), ".isotopes");
  const sessionStore = new DefaultSessionStore({ dataDir });

  // Start Discord transport if configured
  if (config.discord) {
    const token = getDiscordToken(config.discord);

    const discord = new DiscordTransport({
      token,
      agentManager,
      sessionStore,
      defaultAgentId: config.discord.defaultAgentId,
      agentBindings: config.discord.agentBindings,
      allowDMs: config.discord.allowDMs,
      channelAllowlist: config.discord.channelAllowlist,
    });

    await discord.start();
    logger.info("Discord transport started");
  }

  // Keep process alive
  logger.info("Running... Press Ctrl+C to stop");

  // Graceful shutdown
  process.on("SIGINT", async () => {
    logger.info("Shutting down...");
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("Shutting down...");
    process.exit(0);
  });
}

main().catch((error) => {
  logger.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
