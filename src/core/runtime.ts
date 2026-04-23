// src/core/runtime.ts — Isotopes application runtime
// Orchestrates agents, transports, cron, heartbeat, API server, and graceful shutdown.
// Entry points (CLI foreground, daemon, TUI) call `createRuntime()` to wire everything up.

import {
  toAgentConfig,
  resolveSubagentConfig,
  resolveSandboxConfigFromFile,
  type IsotopesConfigFile,
} from "./config.js";
import path from "node:path";
import { initSubagentBackend, setSubagentSessionStoreFactory } from "../tools/subagent.js";
import { PiMonoCore } from "./pi-mono.js";
import { DefaultAgentManager } from "./agent-manager.js";
import { DefaultSessionStore } from "./session-store.js";
import { SessionStoreManager } from "./session-store-manager.js";
import { DiscordTransportManager } from "../transports/discord-manager.js";
import { ThreadBindingManager } from "./thread-bindings.js";
import { createLogger } from "./logger.js";
import { LazyTransportContext } from "../tools/react.js";
import { ProcessRegistry } from "../tools/exec.js";
import { ToolRegistry } from "./tools.js";
import { ContainerManager, SandboxExecutor } from "../sandbox/index.js";
import { initializeAgent } from "./agent-init.js";
import {
  getThreadBindingsPath,
  ensureDirectories,
} from "./paths.js";
import { HotReloadManager } from "../workspace/index.js";
import { ApiServer } from "../api/server.js";
import { CronScheduler } from "../automation/cron-job.js";
import { HeartbeatManager } from "../automation/heartbeat.js";
import { UsageTracker } from "./usage-tracker.js";
import { PluginManager } from "../plugins/manager.js";
import { getIsotopesHome } from "./paths.js";
import { runAgentLoop } from "./agent-runner.js";

const log = createLogger("runtime");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RuntimeOptions {
  config: IsotopesConfigFile;
  apiPort?: number;
}

export interface Runtime {
  agentManager: DefaultAgentManager;
  agentWorkspaces: Map<string, string>;
  cronScheduler: CronScheduler;
  usageTracker: UsageTracker;
  pluginManager: PluginManager;
  discordManager?: DiscordTransportManager;
  apiServer: ApiServer;
  shutdown: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function createRuntime(opts: RuntimeOptions): Promise<Runtime> {
  const { config, apiPort } = opts;

  await ensureDirectories();

  // SessionStoreManager backs both main-agent transcripts and subagent runs.
  // Plugin system — initialize early so hooks are available during agent init.
  const pluginManager = new PluginManager();
  const sessionStoreManager = new SessionStoreManager({ hooks: pluginManager.getHooks() });

  // Initialize core first — the builtin subagent backend hosts subagents
  // in-process via this same core.
  const core = new PiMonoCore();
  const agentManager = new DefaultAgentManager(core);

  // Initialize subagent backend
  if (config.subagent?.enabled) {
    const subagentConfig = resolveSubagentConfig(config.subagent);
    initSubagentBackend({
      config: subagentConfig,
      core,
    });
    log.info(`Subagent backend initialized (allowedTypes: ${[...subagentConfig.allowedTypes].join(",")}, claude.permissionMode: ${subagentConfig.claude.permissionMode})`);

    setSubagentSessionStoreFactory((agentId) => sessionStoreManager.getOrCreate(agentId));
    log.info("Subagent session store factory → shared SessionStoreManager");
  }

  const agentWorkspaces = new Map<string, string>();
  const transportContexts = new Map<string, LazyTransportContext>();
  const processRegistries = new Map<string, ProcessRegistry>();
  const toolRegistries = new Map<string, ToolRegistry>();

  // Build sandbox executor if any agent uses sandboxing
  let sandboxExecutor: SandboxExecutor | undefined;
  const baseSandboxFile = config.agentDefaults?.sandbox ?? config.sandbox;
  const resolvedAgentConfigs = config.agents.map((a) =>
    toAgentConfig(a, config.agentDefaults, config.provider, config.tools, config.compaction, config.sandbox),
  );
  const anySandboxed = resolvedAgentConfigs.some((c) => c.sandbox && c.sandbox.mode !== "off");
  if (anySandboxed) {
    if (!baseSandboxFile) {
      throw new Error(
        "Sandbox is enabled for at least one agent but no agents-level sandbox config was found. " +
          "Define `agents.defaults.sandbox` or top-level `sandbox` with a docker config.",
      );
    }
    const baseSandbox = resolveSandboxConfigFromFile("<agents-defaults>", undefined, baseSandboxFile);
    const dockerConfig = baseSandbox?.docker;
    if (!dockerConfig) {
      throw new Error("Sandbox is enabled but no docker config could be resolved");
    }
    const containerManager = new ContainerManager(dockerConfig);
    sandboxExecutor = new SandboxExecutor(containerManager, baseSandbox!);
    log.info(`Sandbox executor initialized (image: ${dockerConfig.image})`);
  }

  // Create agents
  for (let agentIdx = 0; agentIdx < config.agents.length; agentIdx++) {
    const agentFile = config.agents[agentIdx];
    const transportCtx = new LazyTransportContext();

    const result = await initializeAgent({
      agentFile,
      agentDefaults: config.agentDefaults,
      provider: config.provider,
      globalTools: config.tools,
      compaction: config.compaction,
      sandbox: config.sandbox,
      subagent: config.subagent,
      core,
      agentManager,
      sandboxExecutor,
      transportContext: transportCtx,
      hooks: pluginManager.getHooks(),
    });

    agentWorkspaces.set(result.agentConfig.id, result.workspacePath);
    transportContexts.set(result.agentConfig.id, transportCtx);
    processRegistries.set(result.agentConfig.id, result.processRegistry);
    toolRegistries.set(result.agentConfig.id, result.toolRegistry);
  }

  // Hot-reload workspace files
  const hotReload = new HotReloadManager(agentManager, { enabled: true, debounceMs: 500 });

  // Discover and load plugins (PluginManager created earlier for hooks)
  const pluginDirs = [
    path.join(import.meta.dirname, "../../plugins"),
    path.join(getIsotopesHome(), "plugins"),
    ...[...agentWorkspaces.values()].map((w) => path.join(w, "plugins")),
  ];
  await pluginManager.discoverAndLoad(pluginDirs, config.plugins);

  // Inject plugin-registered tools into each agent's tool registry
  const toolPluginRegistry = pluginManager.getToolPluginRegistry();
  for (const [agentId, toolRegistry] of toolRegistries) {
    const resolved = toolPluginRegistry.resolve({
      agentId,
      workspacePath: agentWorkspaces.get(agentId)!,
    });
    for (const { tool, handler } of resolved) {
      if (toolRegistry.has(tool.name)) {
        log.warn(`Plugin tool "${tool.name}" conflicts with existing tool for agent "${agentId}" — skipping`);
        continue;
      }
      toolRegistry.register(tool, handler);
    }
    if (resolved.length > 0) {
      log.info(`Injected ${resolved.length} plugin tool(s) into agent "${agentId}"`);
    }
  }

  for (const [agentId, workspacePath] of agentWorkspaces) {
    hotReload.register(agentId, workspacePath);
  }
  hotReload.onReload((event) => {
    log.info(`Hot-reload: workspace reloaded for "${event.agentId}" (${event.changedFiles.join(", ")})`);
  });
  hotReload.start();
  log.info(`Hot-reload enabled for ${config.agents.length} agent(s)`);

  // Heartbeat managers
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
        const cache = agentManager.get(agentId);
        if (!cache) throw new Error(`Agent "${agentId}" not found`);
        const store = await sessionStoreManager.getOrCreate(agentId);
        const sessionKey = `heartbeat:${agentId}`;
        const session = (await store.findByKey(sessionKey)) ?? (await store.create(agentId, { key: sessionKey }));
        const result = await runAgentLoop({
          cache,
          sessionStore: store,
          sessionId: session.id,
          systemPrompt: agentManager.getSystemPrompt(agentId) ?? "",
          textInput: prompt,
          log,
        });
        return result.responseText;
      },
    });

    hb.start();
    heartbeatManagers.push(hb);
    log.info(`Heartbeat enabled for "${agentFile.id}" (every ${agentFile.heartbeat.intervalSeconds ?? 300}s)`);
  }

  // Cron scheduler
  const cronScheduler = new CronScheduler();
  const usageTracker = new UsageTracker();

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
    log.info(`Registered ${agentFile.cron.tasks.length} cron task(s) for "${agentFile.id}"`);
  }

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
    log.info(`Registered ${config.cron.length} top-level cron task(s)`);
  }

  cronScheduler.onTrigger(async (job) => {
    const cache = agentManager.get(job.agentId);
    if (!cache) {
      log.error(`Cron job "${job.name}" references unknown agent "${job.agentId}"`);
      return;
    }

    let prompt: string;
    if (job.action.type === "prompt") {
      prompt = job.action.prompt;
    } else if (job.action.type === "message") {
      prompt = job.action.content;
    } else {
      log.warn(`Cron job "${job.name}" has unsupported action type "${job.action.type}" — skipping`);
      return;
    }

    const sessionKey = `cron:${job.agentId}:${job.name}`;
    log.info(`Cron executing "${job.name}" for agent "${job.agentId}" (session: ${sessionKey})`);

    try {
      const store = await sessionStoreManager.getOrCreate(job.agentId);
      const session = (await store.findByKey(sessionKey)) ?? (await store.create(job.agentId, { key: sessionKey }));
      const result = await runAgentLoop({
        cache,
        sessionStore: store,
        sessionId: session.id,
        systemPrompt: agentManager.getSystemPrompt(job.agentId) ?? "",
        textInput: prompt,
        log,
      });
      log.info(`Cron "${job.name}" completed (${result.responseText.length} chars)`);
    } catch (err) {
      log.error(`Cron "${job.name}" failed:`, err);
    }
  });

  cronScheduler.start();
  if (cronScheduler.listJobs().length > 0) {
    log.info(`Cron scheduler started with ${cronScheduler.listJobs().length} job(s)`);
  }

  // Discord transport
  let discordManager: DiscordTransportManager | undefined;
  let discordSessionStores: Map<string, DefaultSessionStore> | undefined;

  if (config.channels?.discord) {
    const accounts = config.channels.discord.accounts ?? {};

    if (Object.keys(accounts).length === 0) {
      log.warn("channels.discord present but no accounts configured — skipping");
    } else {
      const sessionStores = new Map<string, DefaultSessionStore>();
      for (const agentFile of config.agents) {
        sessionStores.set(agentFile.id, await sessionStoreManager.getOrCreate(agentFile.id));
      }
      discordSessionStores = sessionStores;

      const firstAccount = Object.values(accounts)[0];
      const defaultAgentId = firstAccount?.defaultAgentId || config.agents[0]?.id;
      const defaultSessionStore =
        sessionStores.get(defaultAgentId) ?? (await sessionStoreManager.getOrCreate(defaultAgentId));

      const threadBindingManager = new ThreadBindingManager({ persistPath: getThreadBindingsPath() });
      await threadBindingManager.load({ clearStale: true });
      if (threadBindingManager.size > 0) {
        log.info(`Loaded ${threadBindingManager.size} persisted thread binding(s)`);
      }

      discordManager = new DiscordTransportManager({
        accounts,
        shared: {
          agentManager,
          sessionStore: defaultSessionStore,
          sessionStoreForAgent: (agentId) =>
            sessionStoreManager.peek(agentId) ?? sessionStores.get(agentId) ?? defaultSessionStore,
          channels: config.channels,
          threadBindingManager,
          usageTracker,
        },
      });

      const anyThreadBindings = Object.values(accounts).some((a) => a.threadBindings?.enabled);
      if (anyThreadBindings) {
        log.info("Discord thread bindings enabled");
      }

      await discordManager.start();
      log.info(`Discord transport started (${discordManager.size} account(s))`);

      const firstTransport = discordManager.getAll().values().next().value;
      if (firstTransport) {
        for (const [agentId, ctx] of transportContexts) {
          ctx.setTransport(firstTransport);
          log.debug(`Bound Discord transport for react tools (agent: ${agentId})`);
        }
      }
    }
  }

  // Plugin transports
  const pluginTransports: import("./types.js").Transport[] = [];
  for (const [id, factory] of pluginManager.getTransportFactories()) {
    try {
      const transport = await factory({ agentManager, sessionStoreManager, config });
      await transport.start();
      pluginTransports.push(transport);
      log.info(`Plugin transport "${id}" started`);
    } catch (err) {
      log.error(`Failed to start plugin transport "${id}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // API server
  const apiServer = new ApiServer(
    { port: apiPort ?? 2712 },
    {
      cronScheduler,
      agentManager,
      usageTracker,
      uiRegistry: pluginManager.getUIRegistry(),
      sessionStoreManager,
      discordSessionStores,
      hooks: pluginManager.getHooks(),
    },
  );
  await apiServer.start();

  log.info("Runtime started");

  // Shutdown handler
  const shutdown = async () => {
    log.info("Shutting down...");
    cronScheduler.stop();
    for (const hb of heartbeatManagers) hb.stop();
    hotReload.stop();
    if (discordManager) await discordManager.stop();
    for (const t of pluginTransports) {
      try { await t.stop(); } catch { /* ignore */ }
    }
    await pluginManager.shutdown();
    await apiServer.stop();
    sessionStoreManager.destroyAll();

    for (const registry of processRegistries.values()) {
      registry.clear();
    }

    if (sandboxExecutor) {
      try {
        await sandboxExecutor.cleanup();
      } catch (err) {
        log.warn(`Sandbox cleanup error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  return {
    agentManager,
    agentWorkspaces,
    cronScheduler,
    usageTracker,
    pluginManager,
    discordManager,
    apiServer,
    shutdown,
  };
}
