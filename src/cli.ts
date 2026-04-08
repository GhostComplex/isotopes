#!/usr/bin/env node
// src/cli.ts — Isotopes CLI entry point
// Start agents from configuration file.

import { parseArgs } from "node:util";
import { VERSION } from "./index.js";
import { loadConfig, toAgentConfig, getDiscordToken } from "./core/config.js";
import { PiMonoCore } from "./core/pi-mono.js";
import { DefaultAgentManager } from "./core/agent-manager.js";
import { DefaultSessionStore } from "./core/session-store.js";
import { DiscordTransport } from "./transports/discord.js";
import { logger } from "./core/logger.js";
import {
  ToolRegistry,
  buildToolGuardPrompt,
  createWorkspaceToolsWithGuards,
  resolveToolGuards,
} from "./core/tools.js";
import {
  getConfigPath,
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

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
  allowPositionals: false,
});

// ---------------------------------------------------------------------------
// Help & version
// ---------------------------------------------------------------------------

if (values.help) {
  console.log(`
Isotopes v${VERSION}

Usage: isotopes

Config: ~/.isotopes/isotopes.yaml

Environment:
  ISOTOPES_HOME   Override home directory (default: ~/.isotopes)
  LOG_LEVEL       Set log level (debug/info/warn/error)
  DEBUG=isotopes  Enable debug logging
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
  // Ensure base directories exist
  await ensureDirectories();

  // Load config from fixed path
  const configPath = getConfigPath();
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
    const workspaceTools = createWorkspaceToolsWithGuards(
      agentConfig.workspacePath,
      agentConfig.toolSettings,
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

    const discord = new DiscordTransport({
      token,
      agentManager,
      sessionStore: defaultSessionStore,
      sessionStoreForAgent: (agentId) => sessionStores.get(agentId) || defaultSessionStore,
      defaultAgentId,
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
