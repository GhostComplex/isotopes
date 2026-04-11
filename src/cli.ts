#!/usr/bin/env node
// src/cli.ts — Isotopes CLI entry point
// Start agents from configuration file, with daemon lifecycle commands.

import { parseArgs } from "node:util";
import path from "node:path";
import { VERSION } from "./index.js";
import {
  loadConfig,
  toAgentConfig,
  resolveAcpConfig,
  resolveSubagentConfig,
} from "./core/config.js";
import { initSubagentBackend } from "./tools/subagent.js";
import { PiMonoCore } from "./core/pi-mono.js";
import { DefaultAgentManager } from "./core/agent-manager.js";
import { DefaultSessionStore } from "./core/session-store.js";
import { DiscordTransportManager } from "./transports/discord-manager.js";
import { ThreadBindingManager } from "./core/thread-bindings.js";
import { AcpSessionManager } from "./acp/index.js";
import { logger } from "./core/logger.js";
import {
  ToolRegistry,
  buildToolGuardPrompt,
  createWorkspaceToolsWithGuards,
  resolveToolGuards,
  applyToolPolicy,
} from "./core/tools.js";
import { createSelfIterationTools } from "./tools/self-iteration.js";
import { createIterateCodebaseTool } from "./tools/iterate-codebase.js";
import {
  getConfigPath,
  getIsotopesHome,
  getLogsDir,
  ensureDirectories,
  ensureWorkspaceDir,
  getSessionsDir,
  getThreadBindingsPath,
} from "./core/paths.js";
import {
  loadWorkspaceContext,
  buildSystemPrompt,
  ensureWorkspaceStructure,
} from "./core/workspace.js";
import { HotReloadManager } from "./workspace/index.js";
import { seedWorkspaceTemplates } from "./workspace/templates.js";
import { reconcileWorkspaceState } from "./workspace/state.js";
import { DaemonProcess } from "./daemon/process.js";
import { ServiceManager, getPlatform, type ServiceConfig } from "./daemon/service.js";
import { ApiServer } from "./api/server.js";
import { CronScheduler } from "./automation/cron-job.js";
import { HeartbeatManager } from "./automation/heartbeat.js";
import { UsageTracker } from "./core/usage-tracker.js";

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
  isotopes reload [agentId]          Reload workspace (hot-reload)

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

  // Initialize subagent backend with config (M8)
  if (config.acp?.enabled) {
    const subagentConfig = resolveSubagentConfig(config.acp.subagent);
    initSubagentBackend({
      permissionMode: subagentConfig.permissionMode,
      allowedTools: subagentConfig.allowedTools,
    });
    logger.info(`Subagent backend initialized (permissionMode: ${subagentConfig.permissionMode})`);
  }

  // Initialize core with tool registry
  const core = new PiMonoCore();
  const agentManager = new DefaultAgentManager(core);

  // Create agents with workspace tools
  const agentWorkspaces = new Map<string, string>();
  const isSingleAgent = config.agents.length === 1;

  for (const agentFile of config.agents) {
    const agentConfig = toAgentConfig(agentFile, config.agentDefaults, config.provider, config.tools, config.compaction, config.sandbox);

    // Workspace layout (mirrors OpenClaw):
    //   Single agent:    ~/.isotopes/workspace/
    //   Multiple agents: ~/.isotopes/workspace-{agentId}/
    const workspaceKey = isSingleAgent ? "default" : agentConfig.id;
    const workspacePath = await ensureWorkspaceDir(workspaceKey);
    agentWorkspaces.set(agentConfig.id, workspacePath);

    // Seed workspace templates on first creation (M11.2)
    const seededFiles = await seedWorkspaceTemplates(workspacePath);
    if (seededFiles.length > 0) {
      logger.info(`Seeded ${seededFiles.length} template file(s) for ${agentConfig.id}: ${seededFiles.join(", ")}`);
    }

    // Reconcile workspace state (M11.3)
    await reconcileWorkspaceState(workspacePath);

    // Ensure workspace directory structure exists (sessions/, memory/)
    await ensureWorkspaceStructure(workspacePath);

    // Load workspace context (SOUL.md, TOOLS.md, MEMORY.md, BOOTSTRAP.md, etc.)
    const workspaceContext = await loadWorkspaceContext(workspacePath);
    const baseSystemPrompt = agentConfig.systemPrompt; // Store before workspace assembly
    agentConfig.systemPrompt = buildSystemPrompt(agentConfig.systemPrompt, workspaceContext);
    logger.debug(`Loaded workspace context for ${agentConfig.id}: systemPrompt=${workspaceContext.systemPromptAdditions.length > 0}, memory=${workspaceContext.memory !== null}`);

    // Register workspace tools for this agent
    const resolvedToolGuards = resolveToolGuards(agentConfig.toolSettings);
    const toolRegistry = new ToolRegistry();
    const subagentEnabled = config.acp?.enabled === true;
    const agentAllowedWorkspaces = agentFile.allowedWorkspaces ?? [];
    const workspaceTools = createWorkspaceToolsWithGuards(
      workspacePath,
      agentConfig.toolSettings,
      subagentEnabled,
      agentAllowedWorkspaces,
    );

    // Apply tool policy (allow/deny) before registration
    const filteredTools = applyToolPolicy(workspaceTools, agentConfig.toolSettings);
    for (const { tool, handler } of filteredTools) {
      toolRegistry.register(tool, handler);
    }

    // Register self-iteration tools if enabled (M10.6)
    if (agentFile.selfIteration?.enabled) {
      const selfIterationTools = createSelfIterationTools({
        workspacePath,
        allowedFiles: agentFile.selfIteration.allowedFiles,
        backup: agentFile.selfIteration.backup ?? true,
      });
      for (const { tool, handler } of selfIterationTools) {
        toolRegistry.register(tool, handler);
      }
      logger.info(`Self-iteration tools enabled for ${agentConfig.id}`);

      // Register iterate_codebase tool alongside self-iteration
      const { tool: iterTool, handler: iterHandler } = createIterateCodebaseTool({
        workspacePath,
        repoPath: process.cwd(),
        subagentEnabled: config.acp?.enabled === true,
        allowedWorkspaces: agentAllowedWorkspaces,
      });
      toolRegistry.register(iterTool, iterHandler);
    }

    // Build tool guard prompt and store it for hot-reload persistence (M11.4)
    const toolGuardPrompt = buildToolGuardPrompt(toolRegistry.list(), resolvedToolGuards, workspacePath, agentAllowedWorkspaces);
    agentConfig.systemPrompt = [
      agentConfig.systemPrompt,
      toolGuardPrompt,
    ].filter(Boolean).join("\n\n---\n\n");
    core.setToolRegistry(agentConfig.id, toolRegistry);

    await agentManager.create(agentConfig, { workspacePath, toolGuardPrompt, baseSystemPrompt });
    logger.info(`Created agent: ${agentConfig.id} (workspace: ${workspacePath}, tools: ${toolRegistry.list().length})`);
  }

  // Initialize hot-reload for workspace files (M10.5)
  const hotReload = new HotReloadManager(agentManager, { enabled: true, debounceMs: 500 });
  for (const [agentId, workspacePath] of agentWorkspaces) {
    hotReload.register(agentId, workspacePath);
  }
  hotReload.onReload((event) => {
    logger.info(`Hot-reload: workspace reloaded for "${event.agentId}" (${event.changedFiles.join(", ")})`);
  });
  hotReload.start();
  logger.info(`Hot-reload enabled for ${config.agents.length} agent(s)`);

  // Start heartbeat managers for agents with heartbeat config (#191)
  const heartbeatManagers: HeartbeatManager[] = [];

  for (const agentFile of config.agents) {
    if (!agentFile.heartbeat?.enabled) continue;

    const workspacePath = agentWorkspaces.get(agentFile.id);
    if (!workspacePath) continue;

    const hb = new HeartbeatManager({
      agentId: agentFile.id,
      workspacePath,
      config: { ...agentFile.heartbeat, enabled: true },
      runAgentLoop: async (agentId, prompt, _sessionKey) => {
        const agent = agentManager.get(agentId);
        if (!agent) throw new Error(`Agent "${agentId}" not found`);

        let responseText = "";
        for await (const event of agent.prompt(prompt)) {
          if (event.type === "text_delta") {
            responseText += event.text;
          }
        }
        return responseText;
      },
    });

    hb.start();
    heartbeatManagers.push(hb);
    logger.info(`Heartbeat enabled for "${agentFile.id}" (every ${agentFile.heartbeat.intervalSeconds ?? 300}s)`);
  }

  // Shared instances for Discord transport and API server
  const acpConfig = resolveAcpConfig(config.acp);
  const acpSessionManager = new AcpSessionManager(
    acpConfig ?? { enabled: false, backend: "acpx", defaultAgent: config.agents[0]?.id ?? "default" },
  );
  const cronScheduler = new CronScheduler();
  const usageTracker = new UsageTracker();

  // Register cron jobs from config (#193)
  // Per-agent cron tasks
  for (const agentFile of config.agents) {
    if (!agentFile.cron?.tasks?.length) continue;

    for (const task of agentFile.cron.tasks) {
      cronScheduler.register({
        name: task.name,
        expression: task.schedule,
        agentId: agentFile.id,
        channelId: task.channel,
        action: { type: "prompt", prompt: task.prompt },
        enabled: task.enabled ?? true,
      });
    }
    logger.info(`Registered ${agentFile.cron.tasks.length} cron task(s) for "${agentFile.id}"`);
  }

  // Top-level cron tasks (from config.cron)
  if (config.cron?.length) {
    for (const task of config.cron) {
      cronScheduler.register({
        name: task.name,
        expression: task.expression,
        agentId: task.agentId,
        action: task.action,
        enabled: task.enabled ?? true,
      });
    }
    logger.info(`Registered ${config.cron.length} top-level cron task(s)`);
  }

  // Wire up cron trigger to prompt agents
  cronScheduler.onTrigger(async (job) => {
    const agent = agentManager.get(job.agentId);
    if (!agent) {
      logger.error(`Cron job "${job.name}" references unknown agent "${job.agentId}"`);
      return;
    }

    let prompt: string;
    if (job.action.type === "prompt") {
      prompt = job.action.prompt;
    } else if (job.action.type === "message") {
      prompt = job.action.content;
    } else {
      logger.warn(`Cron job "${job.name}" has unsupported action type "${job.action.type}" — skipping`);
      return;
    }

    const sessionKey = `cron:${job.agentId}:${job.name}`;
    logger.info(`Cron executing "${job.name}" for agent "${job.agentId}" (session: ${sessionKey})`);

    try {
      let responseText = "";
      for await (const event of agent.prompt(prompt)) {
        if (event.type === "text_delta") {
          responseText += event.text;
        }
      }
      logger.info(`Cron "${job.name}" completed (${responseText.length} chars)`);
    } catch (err) {
      logger.error(`Cron "${job.name}" failed:`, err);
    }
  });

  // Start the scheduler
  cronScheduler.start();
  if (cronScheduler.listJobs().length > 0) {
    logger.info(`Cron scheduler started with ${cronScheduler.listJobs().length} job(s)`);
  }

  // Start Discord transport if configured
  let discordManager: DiscordTransportManager | undefined;

  if (config.discord) {
    // Accounts are always normalized by loadConfig (legacy token → accounts.default)
    const accounts = config.discord.accounts ?? {};

    if (Object.keys(accounts).length === 0) {
      logger.warn("Discord config present but no accounts or token configured — skipping");
    } else {
      // Create session store per agent (sessions live in workspace)
      const sessionStores = new Map<string, DefaultSessionStore>();

      for (const agentFile of config.agents) {
        const workspacePath = agentWorkspaces.get(agentFile.id);
        const sessionsDir = workspacePath ? path.join(workspacePath, "sessions") : getSessionsDir(agentFile.id);
        sessionStores.set(agentFile.id, new DefaultSessionStore({ dataDir: sessionsDir }));
      }

      await Promise.all([...sessionStores.values()].map((store) => store.init()));

      // Use first agent's session store as default
      const defaultAgentId = config.discord.defaultAgentId || config.agents[0]?.id;
      let defaultSessionStore = sessionStores.get(defaultAgentId);
      if (!defaultSessionStore) {
        const fallbackWorkspace = agentWorkspaces.get(defaultAgentId || "default");
        const fallbackSessionsDir = fallbackWorkspace
          ? path.join(fallbackWorkspace, "sessions")
          : getSessionsDir(defaultAgentId || "default");
        defaultSessionStore = new DefaultSessionStore({
          dataDir: fallbackSessionsDir,
        });
        await defaultSessionStore.init();
      }

      const threadBindings = config.discord.threadBindings
        ? {
            enabled: config.discord.threadBindings.enabled ?? false,
            spawnAcpSessions: config.discord.threadBindings.spawnAcpSessions,
          }
        : undefined;

      // Create and load persistent thread binding manager
      const threadBindingManager = new ThreadBindingManager({
        persistPath: getThreadBindingsPath(),
      });
      await threadBindingManager.load({ clearStale: true });
      if (threadBindingManager.size > 0) {
        logger.info(`Loaded ${threadBindingManager.size} persisted thread binding(s)`);
      }

      discordManager = new DiscordTransportManager({
        accounts,
        shared: {
          agentManager,
          sessionStore: defaultSessionStore,
          sessionStoreForAgent: (agentId) => sessionStores.get(agentId) || defaultSessionStore,
          channels: config.channels,
          threadBindings,
          threadBindingManager,
          enableSubagentStreaming: config.discord.subagentStreaming?.enabled,
          subagentShowToolCalls: config.discord.subagentStreaming?.showToolCalls,
          allowBots: config.discord.allowBots,
          context: config.discord.context,
          usageTracker,
          adminUsers: config.discord.adminUsers,
        },
      });

      if (threadBindings?.enabled) {
        // Attach ACP session manager to thread binding manager once (shared across all accounts)
        if (acpConfig) {
          threadBindingManager.attachAcpSessionManager(acpSessionManager, {
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

      await discordManager.start();
      logger.info(`Discord transport started (${discordManager.size} account(s))`);
    }
  }

  // Start API server (dashboard + REST API + WebChat)
  // Create a session store for web chat (uses first agent's workspace)
  const defaultChatAgentId = config.agents[0]?.id ?? "default";
  const chatWorkspacePath = agentWorkspaces.get(defaultChatAgentId);
  const chatSessionsDir = chatWorkspacePath
    ? path.join(chatWorkspacePath, "chat-sessions")
    : getSessionsDir(defaultChatAgentId);
  const chatSessionStore = new DefaultSessionStore({ dataDir: chatSessionsDir });
  await chatSessionStore.init();

  const apiServer = new ApiServer(
    { port: 2712 },
    acpSessionManager,
    cronScheduler,
    undefined,       // configReloader
    agentManager,
    chatSessionStore,
    usageTracker,
  );
  await apiServer.start();
  logger.info("Dashboard available at http://127.0.0.1:2712/dashboard");
  logger.info("WebChat available at http://127.0.0.1:2712/chat");

  // Keep process alive
  logger.info("Running... Press Ctrl+C to stop");

  // Graceful shutdown
  process.on("SIGINT", async () => {
    logger.info("Shutting down...");
    cronScheduler.stop();
    for (const hb of heartbeatManagers) hb.stop();
    hotReload.stop();
    if (discordManager) await discordManager.stop();
    await apiServer.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("Shutting down...");
    cronScheduler.stop();
    for (const hb of heartbeatManagers) hb.stop();
    hotReload.stop();
    if (discordManager) await discordManager.stop();
    await apiServer.stop();
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
