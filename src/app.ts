// Application bootstrapper: orchestrates AgentRuntime, transports, cron,
// heartbeat, API server, and graceful shutdown.

import {
  toAgentConfig,
  resolveSpawningConfig,
  resolveSandboxConfigFromFile,
  type IsotopesConfigFile,
} from "./config.js";
import path from "node:path";
import { SessionStoreManager } from "./legacy/core/session-store-manager.js";
import { createLogger } from "./logging/logger.js";
import { LazyTransportContext } from "./legacy/tools/react.js";
import { ProcessRegistry } from "./legacy/tools/exec.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { ContainerManager, SandboxExecutor } from "./legacy/sandbox/index.js";
import {
  ensureDirectories,
  resolveAgentWorkspacePath,
} from "./paths.js";

import { ApiServer } from "./legacy/plugins/http/server.js";
import { CronScheduler } from "./legacy/automation/cron-job.js";
import { HeartbeatManager } from "./legacy/automation/heartbeat.js";
import { PluginManager } from "./legacy/plugins/manager.js";
import { getIsotopesHome } from "./paths.js";
import { AgentRuntime } from "./agent/runtime.js";
import { ClaudeRunner } from "./agent/runners/claude/runner.js";
import { consumeRootRun } from "./legacy/core/agent-run.js";

const log = createLogger("runtime");

export interface RuntimeOptions {
  config: IsotopesConfigFile;
  apiPort?: number;
}

export interface Runtime {
  agentRuntime: AgentRuntime;
  agentWorkspaces: Map<string, string>;
  cronScheduler: CronScheduler;
  pluginManager: PluginManager;
  apiServer: ApiServer;
  shutdown: () => Promise<void>;
}

export async function createRuntime(opts: RuntimeOptions): Promise<Runtime> {
  const { config, apiPort } = opts;

  await ensureDirectories();

  // Plugins must come up first so hooks are wired before any agent boots.
  const pluginManager = new PluginManager();
  const sessionStoreManager = new SessionStoreManager({ hooks: pluginManager.getHooks() });

  if (!config.provider) {
    throw new Error("config.provider is required (top-level provider config in isotopes.yaml)");
  }

  const allowedRoots: string[] = [];
  for (const a of config.agents) {
    if (a.allowedWorkspaces?.length) allowedRoots.push(...a.allowedWorkspaces);
  }
  const agentRuntime = new AgentRuntime({
    allowedWorkspaceRoots: allowedRoots,
    globalProvider: config.provider,
    hooks: pluginManager.getHooks(),
  });

  // Bundled non-default runners — registered here so runtime stays
  // unaware of their config schema.
  if (config.spawning?.enabled) {
    const resolved = resolveSpawningConfig(config.spawning);
    agentRuntime.registerRunner("claude", new ClaudeRunner(() => resolved.claude));
  }

  const agentWorkspaces = new Map<string, string>();
  const transportContexts = new Map<string, LazyTransportContext>();
  const processRegistries = new Map<string, ProcessRegistry>();
  const toolRegistries = new Map<string, AgentTool[]>();

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

  const spawnableAgentIds = config.agents
    .filter((a) => a.spawnable === true)
    .map((a) => a.id);

  for (const agentFile of config.agents) {
    const transportCtx = new LazyTransportContext();
    const sessionStore = await sessionStoreManager.getOrCreate(agentFile.id);
    const result = await agentRuntime.addAgent({
      agentFile,
      agentDefaults: config.agentDefaults,
      provider: config.provider,
      globalTools: config.tools,
      compaction: config.compaction,
      sandbox: config.sandbox,
      spawning: config.spawning,
      sandboxExecutor,
      transportContext: transportCtx,
      spawnableAgentIds,
      sessionStore,
    });

    agentWorkspaces.set(result.agent.id, result.workspacePath);
    transportContexts.set(result.agent.id, transportCtx);
    processRegistries.set(result.agent.id, result.processRegistry);
    toolRegistries.set(result.agent.id, result.tools);
  }

  const pluginDirs = [
    path.join(import.meta.dirname, "../plugins"),
    path.join(getIsotopesHome(), "plugins"),
    ...[...agentWorkspaces.values()].map((w) => path.join(w, "plugins")),
  ];
  await pluginManager.discoverAndLoad(pluginDirs, config.plugins);

  const toolPluginRegistry = pluginManager.getToolPluginRegistry();
  for (const [agentId, tools] of toolRegistries) {
    const resolved = toolPluginRegistry.resolve({
      agentId,
      workspacePath: agentWorkspaces.get(agentId)!,
    });
    const existingNames = new Set(tools.map((t) => t.name));
    let injected = 0;
    for (const t of resolved) {
      if (existingNames.has(t.name)) {
        log.warn(`Plugin tool "${t.name}" conflicts with existing tool for agent "${agentId}" — skipping`);
        continue;
      }
      tools.push(t);
      existingNames.add(t.name);
      injected++;
    }
    if (injected > 0) {
      agentRuntime.setAgentTools(agentId, tools);
      log.info(`Injected ${injected} plugin tool(s) into agent "${agentId}"`);
    }
  }

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
        const store = await sessionStoreManager.getOrCreate(agentId);
        const sessionKey = `heartbeat:${agentId}`;
        const session = (await store.findByKey(sessionKey)) ?? (await store.create(agentId, { key: sessionKey }));
        const result = await consumeRootRun(agentRuntime, {
          to: agentId,
          sessionId: session.id,
          content: prompt,
          ...((c) => c ? { cwd: resolveAgentWorkspacePath(c) } : {})(agentRuntime.getAgent(agentId)?.config),
          log,
        });
        return result.responseText;
      },
    });

    hb.start();
    heartbeatManagers.push(hb);
    log.info(`Heartbeat enabled for "${agentFile.id}" (every ${agentFile.heartbeat.intervalSeconds ?? 300}s)`);
  }

  const cronScheduler = new CronScheduler();

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
    if (!agentRuntime.getAgent(job.agentId)) {
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
      const result = await consumeRootRun(agentRuntime, {
        to: job.agentId,
        sessionId: session.id,
        content: prompt,
        ...((c) => c ? { cwd: resolveAgentWorkspacePath(c) } : {})(agentRuntime.getAgent(job.agentId)?.config),
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

  const pluginTransports: import("./gateway/types.js").Transport[] = [];
  for (const [id, factory] of pluginManager.getTransportFactories()) {
    try {
      const transport = await factory({
        sessionStoreManager,
        config,
        transportContexts,
        isotopesHome: getIsotopesHome(),
        getSessionStoreForAgent: (agentId) =>
          sessionStoreManager.peek(agentId),
        agentRuntime,
      });
      await transport.start();
      pluginTransports.push(transport);
      log.info(`Plugin transport "${id}" started`);
    } catch (err) {
      log.error(`Failed to start plugin transport "${id}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const apiServer = new ApiServer(
    { port: apiPort ?? 2712 },
    {
      cronScheduler,
      uiRegistry: pluginManager.getUIRegistry(),
      sessionStoreManager,
      hooks: pluginManager.getHooks(),
      agentRuntime,
    },
  );
  await apiServer.start();

  log.info("Runtime started");

  const shutdown = async () => {
    log.info("Shutting down...");
    cronScheduler.stop();
    for (const hb of heartbeatManagers) hb.stop();
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
    agentRuntime,
    agentWorkspaces,
    cronScheduler,
    pluginManager,
    apiServer,
    shutdown,
  };
}
