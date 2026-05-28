import fs from "node:fs/promises";
import {
  resolveSandboxConfigFromFile,
  type IsotopesConfigFile,
} from "./config.js";
import { SessionStoreManager } from "./agent/pi/session-store.js";
import { getApiPort } from "./utils/api-client.js";
import { createLogger } from "./logging/logger.js";
import { LazyChannelContext } from "./channels/types.js";
import { getIsotopesHome, getLogsPath } from "./utils/paths.js";

import { serve, type ServerType } from "@hono/node-server";
import { createApi } from "./http/server.js";
import { CronScheduler } from "./automation/cron-job.js";
import { HeartbeatManager } from "./automation/heartbeat.js";
import { AgentRuntime } from "./agent/runtime.js";
import { discoverExtensionPaths } from "./extensions/pi/loader.js";
import { startChannels } from "./extensions/channels/loader.js";
import { createGateway, type Gateway } from "./gateway/index.js";

const log = createLogger("app");

export interface AppOptions {
  config: IsotopesConfigFile;
}

export interface App {
  agentRuntime: AgentRuntime;
  agentWorkspaces: Map<string, string>;
  cronScheduler: CronScheduler;
  apiServer: ServerType;
  stop: () => Promise<void>;
}

export async function start(opts: AppOptions): Promise<App> {
  const { config } = opts;

  await fs.mkdir(getIsotopesHome(), { recursive: true });
  await fs.mkdir(getLogsPath(), { recursive: true });

  if (!config.provider) {
    throw new Error("config.provider is required (top-level provider config in isotopes.yaml)");
  }

  const sessionStoreManager = new SessionStoreManager();
  const agentRuntime = createAgentRuntime(config);
  const { agentWorkspaces, channelContexts } = await registerAgents(config, agentRuntime, sessionStoreManager);
  const gateway = createGateway({ agentRuntime, sessionStoreManager });
  const heartbeatManagers = startHeartbeats(config, agentWorkspaces, gateway);
  const cronScheduler = startCron(config, agentRuntime, gateway);
  const channels = await startChannels({ gateway, config, channelContexts });
  const apiServer = await startApiServer(cronScheduler, gateway);

  const stop = async () => {
    log.info("Shutting down");
    cronScheduler.stop();
    for (const hb of heartbeatManagers) hb.stop();
    try { await channels.stop(); } catch { /* ignore */ }
    await new Promise<void>((resolve, reject) => {
      apiServer.close((err) => (err ? reject(err) : resolve()));
    });
    sessionStoreManager.stop();
    try {
      await agentRuntime.stop();
    } catch { /* ignore */ }
  };

  log.info("App started");
  return { agentRuntime, agentWorkspaces, cronScheduler, apiServer, stop };
}

function createAgentRuntime(config: IsotopesConfigFile): AgentRuntime {
  const sandboxBaseConfig = config.sandbox
    ? resolveSandboxConfigFromFile("<global>", undefined, config.sandbox)
    : undefined;
  const extensionPaths = discoverExtensionPaths();

  return new AgentRuntime({
    globalProvider: config.provider,
    ...(sandboxBaseConfig ? { sandboxBaseConfig } : {}),
    ...(extensionPaths.length > 0 ? { extensionPaths } : {}),
  });
}

async function registerAgents(
  config: IsotopesConfigFile,
  agentRuntime: AgentRuntime,
  sessionStoreManager: SessionStoreManager,
) {
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
    log.info("Agent registered", { agentId: agentFile.id, runner: agentFile.runner ?? "pi" });
  }

  return { agentWorkspaces, channelContexts };
}

function startHeartbeats(
  config: IsotopesConfigFile,
  agentWorkspaces: Map<string, string>,
  gateway: Gateway,
): HeartbeatManager[] {
  const managers: HeartbeatManager[] = [];

  for (const agentFile of config.agents) {
    if (!agentFile.heartbeat?.enabled) continue;
    const workspacePath = agentWorkspaces.get(agentFile.id);
    if (!workspacePath) continue;

    const hb = new HeartbeatManager({
      agentId: agentFile.id,
      workspacePath,
      config: { ...agentFile.heartbeat, enabled: true },
      runAgentLoop: async (agentId, prompt, sessionKey) => {
        const result = await gateway.dispatchAndWait({
          agentId,
          sessionKey,
          content: prompt,
          source: "heartbeat",
        });
        return result.responseText;
      },
    });

    hb.start();
    log.info("Heartbeat started", { agentId: agentFile.id, intervalSeconds: agentFile.heartbeat.intervalSeconds ?? 300 });
    managers.push(hb);
  }

  return managers;
}

function startCron(
  config: IsotopesConfigFile,
  agentRuntime: AgentRuntime,
  gateway: Gateway,
): CronScheduler {
  const scheduler = new CronScheduler(async (job) => {
    if (!agentRuntime.getAgent(job.agentId)) {
      return;
    }

    const prompt = job.action.type === "prompt" ? job.action.prompt : job.action.content;
    const sessionKey = `cron:${job.agentId}:${job.name}`;

    try {
      await gateway.dispatchAndWait({
        agentId: job.agentId,
        sessionKey,
        content: prompt,
        source: "cron",
      });
    } catch { /* ignore */ }
  });

  for (const agentFile of config.agents) {
    if (!agentFile.cron?.tasks?.length) continue;
    for (const task of agentFile.cron.tasks) {
      scheduler.register({
        name: task.name,
        expression: task.schedule,
        agentId: agentFile.id,
        action: { type: "prompt", prompt: task.prompt },
        enabled: task.enabled ?? true,
      });
    }
  }

  if (config.cron?.length) {
    for (const task of config.cron) {
      scheduler.register({
        name: task.name,
        expression: task.expression,
        agentId: task.agentId,
        action: task.action,
        enabled: task.enabled ?? true,
      });
    }
  }

  scheduler.start();
  log.info("Cron scheduler started", { jobs: scheduler.listJobs().length });
  return scheduler;
}

async function startApiServer(cronScheduler: CronScheduler, gateway: Gateway): Promise<ServerType> {
  const port = getApiPort();
  const api = createApi({ cronScheduler, gateway });
  return new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: api.fetch, port, hostname: "127.0.0.1" }, () => {
      log.info("API server listening", { url: `http://127.0.0.1:${port}` });
      resolve(s);
    });
  });
}
