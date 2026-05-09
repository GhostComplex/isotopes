import {
  resolveSandboxConfigFromFile,
  type IsotopesConfigFile,
} from "./config.js";
import { SessionStoreManager } from "./agent/pi/session-store.js";
import { createLogger } from "./logging/logger.js";
import { LazyChannelContext } from "./channels/channel-context.js";
import {
  ensureDirectories,
  resolveAgentWorkspacePath,
} from "./paths.js";

import { ApiServer } from "./legacy/http/server.js";
import { CronScheduler } from "./automation/cron-job.js";
import { HeartbeatManager } from "./automation/heartbeat.js";
import { AgentRuntime } from "./agent/runtime.js";
import { runAgent } from "./agent/runtime-adapter.js";
import { discoverExtensionPaths } from "./extensions/pi/loader.js";
import { discoverUIEntries } from "./extensions/ui/loader.js";
import { loadChannels } from "./extensions/channels/loader.js";
import { createGateway } from "./gateway/index.js";

const log = createLogger("runtime");

export interface RuntimeOptions {
  config: IsotopesConfigFile;
  apiPort?: number;
}

export interface Runtime {
  agentRuntime: AgentRuntime;
  agentWorkspaces: Map<string, string>;
  cronScheduler: CronScheduler;
  apiServer: ApiServer;
  shutdown: () => Promise<void>;
}

export async function createRuntime(opts: RuntimeOptions): Promise<Runtime> {
  const { config, apiPort } = opts;

  await ensureDirectories();

  const sessionStoreManager = new SessionStoreManager();

  if (!config.provider) {
    throw new Error("config.provider is required (top-level provider config in isotopes.yaml)");
  }

  const sandboxBaseConfig = config.sandbox
    ? resolveSandboxConfigFromFile("<global>", undefined, config.sandbox)
    : undefined;

  const extensionPaths = discoverExtensionPaths();

  const agentRuntime = new AgentRuntime({
    globalProvider: config.provider,
    ...(sandboxBaseConfig ? { sandboxBaseConfig } : {}),
    ...(extensionPaths.length > 0 ? { extensionPaths } : {}),
  });

  const agentWorkspaces = new Map<string, string>();
  const channelContexts = new Map<string, LazyChannelContext>();

  const spawnableAgentIds = config.agents
    .filter((a) => a.spawnable === true && a.enabled !== false)
    .map((a) => a.id);

  for (const agentFile of config.agents) {
    if (agentFile.enabled === false) continue;
    const channelCtx = new LazyChannelContext();
    channelContexts.set(agentFile.id, channelCtx);
    const sessionStore = await sessionStoreManager.getOrCreate(agentFile.id);
    const result = await agentRuntime.register({
      agentFile,
      provider: config.provider,
      globalTools: config.tools,
      sandbox: config.sandbox,
      channelContext: channelCtx,
      spawnableAgentIds,
      sessionStore,
    });

    if (result.workspacePath !== null) agentWorkspaces.set(result.agent.id, result.workspacePath);
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
        const result = await runAgent(agentRuntime, {
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
      const result = await runAgent(agentRuntime, {
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

  const channelLoaders: { stopAll: () => Promise<void> }[] = [];
  {
    const gateway = createGateway({ agentRuntime, sessionStoreManager });
    const channels = await loadChannels({
      gateway,
      config,
      logger: log,
      channelContexts,
    });
    channelLoaders.push(channels);
  }

  const uiEntries = discoverUIEntries();

  const apiServer = new ApiServer(
    { port: apiPort ?? 2712 },
    {
      cronScheduler,
      uiEntries,
      sessionStoreManager,
      agentRuntime,
    },
  );
  await apiServer.start();

  log.info("Runtime started");

  const shutdown = async () => {
    log.info("Shutting down...");
    cronScheduler.stop();
    for (const hb of heartbeatManagers) hb.stop();
    for (const t of channelLoaders) {
      try { await t.stopAll(); } catch { /* ignore */ }
    }
    await apiServer.stop();
    sessionStoreManager.destroyAll();

    try {
      await agentRuntime.shutdown();
    } catch (err) {
      log.warn(`Sandbox cleanup error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    agentRuntime,
    agentWorkspaces,
    cronScheduler,
    apiServer,
    shutdown,
  };
}
