#!/usr/bin/env node
// src/cli.ts — Isotopes CLI entry point
// Start agents from configuration file, with daemon lifecycle commands.

// Side-effect import: pulls env from ~/.claude/settings.json into process.env
// before anything else loads (SDK auth, model overrides). Existing env wins,
// so .env.local and shell exports stay authoritative.
import { resolveBundledSkillsDir } from "./skills/bundled-dir.js";
import "./core/claude-settings-init.js";
import { parseArgs } from "node:util";
import path from "node:path";
import { VERSION } from "./index.js";
import type { Message } from "./core/types.js";
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
import { AcpSessionManager, AgentMessageBus } from "./acp/index.js";
import { logger } from "./core/logger.js";
import {
  ToolRegistry,
  buildToolGuardPrompt,
  createWorkspaceToolsWithGuards,
  resolveToolGuards,
  applyToolPolicy,
} from "./core/tools.js";
import { createIterateCodebaseTool } from "./tools/iterate-codebase.js";
import { createReplyReactTools, LazyTransportContext } from "./tools/reply-react.js";
import { createSessionTools } from "./tools/sessions.js";
import { createExecTools, ProcessRegistry } from "./tools/exec.js";
import {
  getConfigPath,
  getIsotopesHome,
  getLogsDir,
  ensureDirectories,
  ensureExplicitWorkspaceDir,
  ensureWorkspaceDir,
  getSessionsDir,
  getThreadBindingsPath,
  resolveExplicitWorkspacePath,
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

  isotopes chat "prompt" [--agent id] [--json]
                                     One-shot chat with an agent

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
  --agent          Agent ID for chat command
  --json           Output chat response as JSON
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
// Chat command — one-shot chat with an agent
// ---------------------------------------------------------------------------

async function handleChatCommand(): Promise<void> {
  const prompt = positionals[0];

  if (!prompt) {
    console.error("Usage: isotopes chat \"your prompt here\" [--agent id] [--json]");
    process.exit(1);
  }

  // Load config
  const configPath = values.config ?? getConfigPath();
  const config = await loadConfig(configPath);

  if (config.agents.length === 0) {
    console.error("No agents configured");
    process.exit(1);
  }

  // Determine which agent to use
  const agentId = values.agent ?? config.agents[0]?.id;
  const agentFile = config.agents.find((a) => a.id === agentId);

  if (!agentFile) {
    console.error(`Agent not found: ${agentId}`);
    console.error(`Available agents: ${config.agents.map((a) => a.id).join(", ")}`);
    process.exit(1);
  }

  // Convert to agent config and load workspace
  const agentConfig = toAgentConfig(agentFile, config.agentDefaults, config.provider, config.tools, config.compaction, config.sandbox);

  // Resolve workspace path
  let workspacePath: string;
  if (agentFile.workspace) {
    const resolved = resolveExplicitWorkspacePath(agentFile.workspace);
    workspacePath = await ensureExplicitWorkspaceDir(resolved);
  } else {
    const isSingleAgent = config.agents.length === 1;
    const workspaceKey = isSingleAgent ? "default" : agentFile.id;
    workspacePath = await ensureWorkspaceDir(workspaceKey);
  }

  await ensureWorkspaceStructure(workspacePath);
  const workspaceContext = await loadWorkspaceContext(workspacePath, { bundledPath: resolveBundledSkillsDir() });

  // Build system prompt (no extra options needed for CLI chat)
  const agentSystemPrompt = buildSystemPrompt(agentConfig.systemPrompt, workspaceContext);

  // Create agent via PiMonoCore
  const core = new PiMonoCore();
  const agentManager = new DefaultAgentManager(core);

  const agent = await agentManager.create({
    ...agentConfig,
    systemPrompt: agentSystemPrompt,
  });

  // Stream the response
  let responseText = "";
  const userMessage: Message = {
    role: "user",
    content: [{ type: "text", text: prompt }],
  };
  const events = agent.prompt([userMessage]);

  for await (const event of events) {
    if (event.type === "text_delta") {
      if (!values.json) {
        process.stdout.write(event.text);
      }
      responseText += event.text;
    }
  }

  if (values.json) {
    console.log(JSON.stringify({ agent: agentId, prompt, response: responseText }));
  } else {
    // Ensure newline at end
    if (!responseText.endsWith("\n")) {
      console.log();
    }
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
    // Follow mode: use tail -f
    const { spawn } = await import("node:child_process");
    const tail = spawn("tail", ["-f", logFile], { stdio: ["ignore", "pipe", "inherit"] });

    tail.stdout.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        if (line && matchesLevel(line)) {
          console.log(line);
        }
      }
    });

    // Handle Ctrl+C gracefully
    process.on("SIGINT", () => {
      tail.kill();
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

  // Shared ACP instances (created early so session tools can reference them)
  const acpConfig = resolveAcpConfig(config.acp);
  const acpSessionManager = new AcpSessionManager(
    acpConfig ?? { enabled: false, defaultAgent: config.agents[0]?.id ?? "default" },
  );
  const agentMessageBus = new AgentMessageBus(acpSessionManager);
  const startedAt = new Date();
  const modelOverrides = new Map<string, string>();

  // Create agents with workspace tools
  const agentWorkspaces = new Map<string, string>();
  const transportContexts = new Map<string, LazyTransportContext>();
  const processRegistries = new Map<string, ProcessRegistry>();
  const isSingleAgent = config.agents.length === 1;

  for (const agentFile of config.agents) {
    const agentConfig = toAgentConfig(agentFile, config.agentDefaults, config.provider, config.tools, config.compaction, config.sandbox);

    // Create per-agent ProcessRegistry for CLI tool isolation (#289)
    const processRegistry = new ProcessRegistry();
    processRegistries.set(agentConfig.id, processRegistry);

    // Workspace layout:
    //   Explicit config:  agent.workspace (absolute or relative to ISOTOPES_HOME)
    //   Single agent:     ~/.isotopes/workspace/
    //   Multiple agents:  ~/.isotopes/workspace-{agentId}/
    let workspacePath: string;
    if (agentFile.workspace) {
      const resolved = resolveExplicitWorkspacePath(agentFile.workspace);
      workspacePath = await ensureExplicitWorkspaceDir(resolved);
      logger.info(`Using explicit workspace for ${agentConfig.id}: ${workspacePath}`);
    } else {
      const workspaceKey = isSingleAgent ? "default" : agentConfig.id;
      workspacePath = await ensureWorkspaceDir(workspaceKey);
    }
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
    const workspaceContext = await loadWorkspaceContext(workspacePath, { bundledPath: resolveBundledSkillsDir() });
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
      agentConfig.codingMode,
      config.acp?.subagent?.maxTurns,
    );

    // Apply tool policy (allow/deny) before registration
    const filteredTools = applyToolPolicy(workspaceTools, agentConfig.toolSettings);
    for (const { tool, handler } of filteredTools) {
      toolRegistry.register(tool, handler);
    }

    // Register self-iteration tools if enabled (M10.6)
    if (agentFile.selfIteration?.enabled) {
      // Register iterate_codebase tool alongside self-iteration
      const { tool: iterTool, handler: iterHandler } = createIterateCodebaseTool({
        workspacePath,
        repoPath: process.cwd(),
        subagentEnabled: config.acp?.enabled === true,
        allowedWorkspaces: agentAllowedWorkspaces,
      });
      toolRegistry.register(iterTool, iterHandler);
    }

    // Register reply/react tools (transport is bound lazily after Discord starts)
    const transportCtx = new LazyTransportContext();
    transportContexts.set(agentConfig.id, transportCtx);
    for (const { tool, handler } of createReplyReactTools(transportCtx)) {
      toolRegistry.register(tool, handler);
    }

    // Register ACP session tools for inter-agent communication
    const sessionTools = createSessionTools({
      sessionManager: acpSessionManager,
      messageBus: agentMessageBus,
      currentAgentId: agentConfig.id,
      agentManager,
      startedAt,
      modelOverrides,
    });
    for (const { tool, handler } of sessionTools) {
      toolRegistry.register(tool, handler);
    }

    // Register exec/process tools (shared registry across agents)
    if (resolvedToolGuards.cli) {
      const execTools = createExecTools({ cwd: workspacePath, registry: processRegistry });
      const filteredExecTools = applyToolPolicy(execTools, agentConfig.toolSettings);
      for (const { tool, handler } of filteredExecTools) {
        toolRegistry.register(tool, handler);
      }
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
  let discordSessionStores: Map<string, DefaultSessionStore> | undefined;

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
      discordSessionStores = sessionStores;

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

      // Bind the first Discord transport to reply/react tools for each agent
      const firstTransport = discordManager.getAll().values().next().value;
      if (firstTransport) {
        for (const [agentId, ctx] of transportContexts) {
          ctx.setTransport(firstTransport);
          logger.debug(`Bound Discord transport for reply/react tools (agent: ${agentId})`);
        }
      }
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
    { port: getApiPort() },
    acpSessionManager,
    cronScheduler,
    undefined,       // configReloader
    agentManager,
    chatSessionStore,
    usageTracker,
    discordSessionStores,
  );
  await apiServer.start();
  logger.info(`Dashboard available at http://127.0.0.1:${getApiPort()}/dashboard`);
  logger.info(`WebChat available at http://127.0.0.1:${getApiPort()}/chat`);

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

    // Clean up session stores (#286)
    chatSessionStore.destroy();
    if (discordSessionStores) {
      for (const store of discordSessionStores.values()) {
        store.destroy();
      }
    }

    // Kill orphaned background processes (#286, #289)
    for (const registry of processRegistries.values()) {
      registry.clear();
    }

    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("Shutting down...");
    cronScheduler.stop();
    for (const hb of heartbeatManagers) hb.stop();
    hotReload.stop();
    if (discordManager) await discordManager.stop();
    await apiServer.stop();

    // Clean up session stores (#286)
    chatSessionStore.destroy();
    if (discordSessionStores) {
      for (const store of discordSessionStores.values()) {
        store.destroy();
      }
    }

    // Kill orphaned background processes (#286, #289)
    for (const registry of processRegistries.values()) {
      registry.clear();
    }

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

    case "chat":
      await handleChatCommand();
      break;

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
