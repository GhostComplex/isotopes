#!/usr/bin/env node
// src/cli.ts — Isotopes CLI entry point
// Start agents from configuration file, with daemon lifecycle commands.

import { parseArgs } from "node:util";
import path from "node:path";
import { VERSION } from "./index.js";
import {
  loadConfig,
  toAgentConfig,
  getDiscordToken,
  resolveAcpConfig,
} from "./core/config.js";
import { PiMonoCore } from "./core/pi-mono.js";
import { DefaultAgentManager } from "./core/agent-manager.js";
import { DefaultSessionStore } from "./core/session-store.js";
import { DiscordTransport } from "./transports/discord.js";
import { AcpSessionManager } from "./acp/index.js";
import { logger } from "./core/logger.js";
import {
  ToolRegistry,
  buildToolGuardPrompt,
  createWorkspaceToolsWithGuards,
  resolveToolGuards,
} from "./core/tools.js";
import {
  getConfigPath,
  getIsotopesHome,
  getLogsDir,
  ensureDirectories,
  ensureWorkspaceDir,
  getSessionsDir,
  resolveWorkspacePath,
} from "./core/paths.js";
import {
  loadWorkspaceContext,
  buildSystemPrompt,
  ensureWorkspaceStructure,
} from "./core/workspace.js";
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
      path.dirname(new URL(import.meta.url).pathname),
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

const { values } = parseArgs({
  args: subArgs,
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    config: { type: "string", short: "c" },
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
  isotopes start [--config path]     Start as background daemon
  isotopes stop                      Stop the running daemon
  isotopes status                    Show daemon status
  isotopes restart [--config path]   Restart the daemon

  isotopes service install           Install as system service
  isotopes service uninstall         Remove system service
  isotopes service enable            Enable service (auto-start)
  isotopes service disable           Disable service

Options:
  -h, --help       Show this help
  -v, --version    Show version
  -c, --config     Path to config file

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
      if (s.running) {
        console.log(`Isotopes daemon is running`);
        console.log(`  PID:        ${s.pid}`);
        if (s.startedAt) console.log(`  Started:    ${s.startedAt.toISOString()}`);
        if (s.uptime !== undefined) console.log(`  Uptime:     ${formatUptime(s.uptime)}`);
        if (s.configPath) console.log(`  Config:     ${s.configPath}`);
      } else {
        console.log("Isotopes daemon is not running");
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
// Main – foreground run (original behaviour)
// ---------------------------------------------------------------------------

async function main() {
  // Ensure base directories exist
  await ensureDirectories();

  // Load config from fixed path
  const configPath = values.config ?? getConfigPath();
  logger.info(`Loading config from ${configPath}`);

  const config = await loadConfig(configPath);
  logger.info(`Loaded ${config.agents.length} agent(s)`);

  // Initialize core with tool registry
  const core = new PiMonoCore();
  const agentManager = new DefaultAgentManager(core);

  // Create agents with workspace tools
  for (const agentFile of config.agents) {
    const agentConfig = toAgentConfig(agentFile, config.provider, config.tools);

    // Resolve workspace path
    if (agentConfig.workspacePath) {
      agentConfig.workspacePath = resolveWorkspacePath(agentConfig.workspacePath);
    } else {
      // Default workspace: ~/.isotopes/workspaces/<agentId>
      agentConfig.workspacePath = await ensureWorkspaceDir(agentConfig.id);
    }

    // Ensure workspace directory structure exists (sessions/, memory/)
    await ensureWorkspaceStructure(agentConfig.workspacePath);

    // Load workspace context (SOUL.md, TOOLS.md, MEMORY.md)
    const workspaceContext = await loadWorkspaceContext(agentConfig.workspacePath);
    agentConfig.systemPrompt = buildSystemPrompt(agentConfig.systemPrompt, workspaceContext);
    logger.debug(`Loaded workspace context for ${agentConfig.id}: systemPrompt=${workspaceContext.systemPromptAdditions.length > 0}, memory=${workspaceContext.memory !== null}`);

    // Register workspace tools for this agent
    const resolvedToolGuards = resolveToolGuards(agentConfig.toolSettings);
    const toolRegistry = new ToolRegistry();
    const subagentEnabled = config.acp?.enabled === true;
    const workspaceTools = createWorkspaceToolsWithGuards(
      agentConfig.workspacePath,
      agentConfig.toolSettings,
      subagentEnabled,
      agentConfig.allowedWorkspaces ?? [],
    );
    for (const { tool, handler } of workspaceTools) {
      toolRegistry.register(tool, handler);
    }
    agentConfig.systemPrompt = [
      agentConfig.systemPrompt,
      buildToolGuardPrompt(toolRegistry.list(), resolvedToolGuards, agentConfig.workspacePath),
    ].filter(Boolean).join("\n\n---\n\n");
    core.setToolRegistry(agentConfig.id, toolRegistry);

    await agentManager.create(agentConfig);
    logger.info(`Created agent: ${agentConfig.id} (workspace: ${agentConfig.workspacePath}, tools: ${toolRegistry.list().length})`);
  }

  // Start Discord transport if configured
  if (config.discord) {
    const token = getDiscordToken(config.discord);
    const acpConfig = resolveAcpConfig(config.acp);

    // Create session store per agent (sessions live in workspace)
    const sessionStores = new Map<string, DefaultSessionStore>();

    for (const agentFile of config.agents) {
      const sessionsDir = getSessionsDir(agentFile.id);
      sessionStores.set(agentFile.id, new DefaultSessionStore({ dataDir: sessionsDir }));
    }

    await Promise.all([...sessionStores.values()].map((store) => store.init()));

    // Use first agent's session store as default
    const defaultAgentId = config.discord.defaultAgentId || config.agents[0]?.id;
    let defaultSessionStore = sessionStores.get(defaultAgentId);
    if (!defaultSessionStore) {
      defaultSessionStore = new DefaultSessionStore({
        dataDir: getSessionsDir(defaultAgentId || "default"),
      });
      await defaultSessionStore.init();
    }

    const threadBindings = config.discord.threadBindings
      ? {
          enabled: config.discord.threadBindings.enabled ?? false,
          spawnAcpSessions: config.discord.threadBindings.spawnAcpSessions,
        }
      : undefined;

    const discord = new DiscordTransport({
      token,
      agentManager,
      sessionStore: defaultSessionStore,
      sessionStoreForAgent: (agentId) => sessionStores.get(agentId) || defaultSessionStore,
      defaultAgentId,
      agentBindings: config.discord.agentBindings,
      allowDMs: config.discord.allowDMs,
      channelAllowlist: config.discord.channelAllowlist,
      threadBindings,
    });

    if (threadBindings?.enabled) {
      if (acpConfig) {
        const acpSessionManager = new AcpSessionManager(acpConfig);
        discord.getThreadBindingManager().attachAcpSessionManager(acpSessionManager, {
          spawnAcpSessions: threadBindings.spawnAcpSessions ?? false,
        });
        logger.info(
          `Discord thread bindings enabled (spawnAcpSessions=${threadBindings.spawnAcpSessions ?? false})`,
        );
      } else if (threadBindings.spawnAcpSessions) {
        logger.warn(
          "discord.threadBindings.spawnAcpSessions is enabled, but ACP is not configured; sessions will not be auto-created",
        );
      } else {
        logger.info("Discord thread bindings enabled");
      }
    }

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

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  switch (subcommand) {
    case "start":
    case "stop":
    case "status":
    case "restart":
      await handleDaemonCommand();
      break;

    case "service":
      await handleServiceCommand();
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
