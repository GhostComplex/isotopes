import fs from "node:fs/promises";
import {
  type IsotopesConfigFile,
} from "./config.js";
import { SessionStoreManager } from "./agent/pi/session-store.js";
import { createLogger } from "./logging/logger.js";
import { LazyChannelContext } from "./channels/types.js";
import { formatHistory } from "./channels/discord/channel-history.js";
import type { Channel } from "./channels/types.js";
import { getIsotopesHome, getLogsPath } from "./utils/paths.js";

import { CronScheduler } from "./automation/cron-job.js";
import { HeartbeatManager } from "./automation/heartbeat.js";
import type { CronChannelConfig } from "./automation/types.js";
import { AgentRuntime } from "./agent/runtime.js";
import { discoverExtensionPaths } from "./extensions/pi/loader.js";
import { ChannelManager } from "./extensions/channels/loader.js";
import { ApiServer } from "./http/api-server.js";
import { createGateway, type Gateway } from "./gateway/index.js";

const log = createLogger("app");

export interface AppOptions {
  config: IsotopesConfigFile;
}

export interface App {
  agentRuntime: AgentRuntime;
  agentWorkspaces: Map<string, string>;
  cronScheduler: CronScheduler;
  apiServer: ApiServer;
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
  const channelManager = new ChannelManager(config);
  await channelManager.start({ gateway, channelContexts });
  const heartbeatManagers = startHeartbeats(config, agentWorkspaces, gateway);
  const cronScheduler = startCron(config, agentRuntime, gateway, channelManager);
  const apiServer = new ApiServer({ cronScheduler, gateway });
  await apiServer.start();

  const stop = async () => {
    log.info("Shutting down");
    cronScheduler.stop();
    for (const hb of heartbeatManagers) hb.stop();
    await channelManager.stop();
    await apiServer.stop();
    sessionStoreManager.stop();
  };

  log.info("App started");
  return { agentRuntime, agentWorkspaces, cronScheduler, apiServer, stop };
}

function createAgentRuntime(config: IsotopesConfigFile): AgentRuntime {
  const extensionPaths = discoverExtensionPaths();

  return new AgentRuntime({
    globalProvider: config.provider,
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
  channelManager: ChannelManager,
): CronScheduler {
  const scheduler = new CronScheduler(async (job) => {
    if (!agentRuntime.getAgent(job.agentId)) {
      return;
    }

    const prompt = job.action.type === "prompt" ? job.action.prompt : job.action.content;
    const sessionKey = `cron:${job.agentId}:${job.name}`;

    try {
      await runCronJob({
        agentId: job.agentId,
        sessionKey,
        prompt,
        channel: job.channel,
        gateway,
        discord: channelManager.discord,
      });
    } catch (err) {
      log.warn("Cron run failed", { agentId: job.agentId, jobName: job.name, error: err });
    }
  });

  if (config.cron?.length) {
    for (const task of config.cron) {
      scheduler.register({
        name: task.name,
        expression: task.expression,
        agentId: task.agentId,
        action: task.action,
        enabled: task.enabled ?? true,
        ...(task.channel ? { channel: task.channel } : {}),
      });
    }
  }

  scheduler.start();
  log.info("Cron scheduler started", { jobs: scheduler.listJobs().length });
  return scheduler;
}

export interface RunCronJobOpts {
  agentId: string;
  sessionKey: string;
  prompt: string;
  channel?: CronChannelConfig;
  gateway: Pick<Gateway, "dispatchAndWait">;
  discord?: Pick<Channel, "send" | "fetchHistory">;
}

/**
 * Cron pipeline. Read failures abort before dispatch (throw);
 * post failures are logged (the agent's work isn't lost).
 */
export async function runCronJob(
  opts: RunCronJobOpts,
): Promise<{ responseText: string; errorMessage: string | null }> {
  const { agentId, sessionKey, channel, gateway, discord } = opts;
  let { prompt } = opts;

  const target = channel
    ? {
        accountId: channel.accountId,
        channelId: channel.channelId,
        ...(channel.threadId ? { threadId: channel.threadId } : {}),
      }
    : undefined;

  if (channel && target) {
    // readLast is filled by loadConfig; ?? 0 only covers test callers that bypass it.
    const readLast = channel.readLast ?? 0;
    if (readLast > 0) {
      if (!discord) {
        throw new Error(`cron "${agentId}": channel set but Discord is not configured`);
      }
      const entries = await discord.fetchHistory(target, { limit: readLast });
      const block = formatHistory(entries);
      if (block) prompt = `${block}\n\n${prompt}`;
    }
  }

  const result = await gateway.dispatchAndWait({
    agentId,
    sessionKey,
    content: prompt,
    source: "cron",
  });

  if (target && discord) {
    const errText = result.errorMessage?.trim();
    const body = errText ? `⚠️ ${errText}` : result.responseText.trim();
    if (body) {
      try {
        await discord.send(target, body);
      } catch (err) {
        log.warn("Cron post failed", { agentId, channel, error: err });
      }
    }
  }

  return result;
}
