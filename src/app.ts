import fs from "node:fs/promises";
import {
  resolveSandboxConfigFromFile,
  type IsotopesConfigFile,
} from "./config.js";
import { SessionStoreManager } from "./agent/pi/session-store.js";
import { createLogger } from "./logging/logger.js";
import { LazyChannelContext, type ChannelTarget } from "./channels/types.js";
import { ChannelRouter } from "./channels/router.js";
import { matchesAllowedChannel } from "./channels/allowlist.js";
import { getIsotopesHome, getLogsPath } from "./utils/paths.js";

import { CronScheduler } from "./automation/cron-job.js";
import { HeartbeatManager } from "./automation/heartbeat.js";
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

  validateDeliveryAgainstAllowlists(config);

  const sessionStoreManager = new SessionStoreManager();
  const channelRouter = new ChannelRouter();
  const agentRuntime = createAgentRuntime(config, channelRouter);
  const { agentWorkspaces, channelContexts } = await registerAgents(config, agentRuntime, sessionStoreManager);
  const gateway = createGateway({ agentRuntime, sessionStoreManager });
  const channelManager = new ChannelManager(config, channelRouter);
  await channelManager.start({ gateway, channelContexts });
  const heartbeatManagers = startHeartbeats(config, agentWorkspaces, gateway, channelRouter);
  const cronScheduler = startCron(config, agentRuntime, gateway, channelRouter);
  const apiServer = new ApiServer({ cronScheduler, gateway });
  await apiServer.start();

  const stop = async () => {
    log.info("Shutting down");
    cronScheduler.stop();
    for (const hb of heartbeatManagers) hb.stop();
    await channelManager.stop();
    await apiServer.stop();
    sessionStoreManager.stop();
    try {
      await agentRuntime.stop();
    } catch { /* ignore */ }
  };

  log.info("App started");
  return { agentRuntime, agentWorkspaces, cronScheduler, apiServer, stop };
}

function createAgentRuntime(config: IsotopesConfigFile, channelRouter: ChannelRouter): AgentRuntime {
  const sandboxBaseConfig = config.sandbox
    ? resolveSandboxConfigFromFile("<global>", undefined, config.sandbox)
    : undefined;
  const extensionPaths = discoverExtensionPaths();

  return new AgentRuntime({
    globalProvider: config.provider,
    channelRouter,
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
  router: ChannelRouter,
): HeartbeatManager[] {
  const managers: HeartbeatManager[] = [];

  for (const agentFile of config.agents) {
    if (!agentFile.heartbeat?.enabled) continue;
    const workspacePath = agentWorkspaces.get(agentFile.id);
    if (!workspacePath) continue;

    const delivery = agentFile.heartbeat.delivery;

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
        await deliverResult(result, delivery, router, { source: "heartbeat", agentId });
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
  router: ChannelRouter,
): CronScheduler {
  const scheduler = new CronScheduler(async (job) => {
    if (!agentRuntime.getAgent(job.agentId)) {
      return;
    }

    const prompt = job.action.type === "prompt" ? job.action.prompt : job.action.content;
    const sessionKey = `cron:${job.agentId}:${job.name}`;

    try {
      const result = await gateway.dispatchAndWait({
        agentId: job.agentId,
        sessionKey,
        content: prompt,
        source: "cron",
      });
      await deliverResult(result, job.delivery, router, { source: "cron", agentId: job.agentId, job: job.name });
    } catch (err) {
      log.warn("Cron run failed", { agentId: job.agentId, jobName: job.name, error: err });
    }
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
        ...(task.delivery ? { delivery: task.delivery } : {}),
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
        ...(task.delivery ? { delivery: task.delivery } : {}),
      });
    }
  }

  scheduler.start();
  log.info("Cron scheduler started", { jobs: scheduler.listJobs().length });
  return scheduler;
}

async function deliverResult(
  result: { responseText: string; errorMessage?: string | null },
  target: ChannelTarget | undefined,
  router: ChannelRouter,
  ctx: Record<string, unknown>,
): Promise<void> {
  if (!target) return;
  const errText = result.errorMessage?.trim();
  const body = errText ? `⚠️ ${errText}` : result.responseText.trim();
  if (!body) return;
  try {
    await router.send(target, body);
  } catch (err) {
    log.warn("Scheduled delivery failed", { ...ctx, target, error: err });
  }
}

/**
 * Refuse to start if any cron/heartbeat delivery channel is not in the agent's
 * `tools.message.allowedChannels`. Catches misconfigurations early instead of
 * surfacing them at first fire.
 */
function validateDeliveryAgainstAllowlists(config: IsotopesConfigFile): void {
  const allowByAgent = new Map<string, string[]>();
  for (const a of config.agents) {
    const allow = a.tools?.message?.allowedChannels ?? config.tools?.message?.allowedChannels;
    if (allow && allow.length > 0) allowByAgent.set(a.id, allow);
  }

  const violations: string[] = [];
  const check = (agentId: string, label: string, target: ChannelTarget | undefined) => {
    if (!target) return;
    const allow = allowByAgent.get(agentId);
    if (!allow) return; // no allowlist → unrestricted
    if (!matchesAllowedChannel(target, allow)) {
      violations.push(`${label}: agent "${agentId}" cannot deliver to ${target.type}:${target.channelId}`);
    }
  };

  for (const a of config.agents) {
    check(a.id, `heartbeat for "${a.id}"`, a.heartbeat?.delivery);
    for (const t of a.cron?.tasks ?? []) check(a.id, `cron "${t.name}"`, t.delivery);
  }
  for (const t of config.cron ?? []) check(t.agentId, `cron "${t.name}"`, t.delivery);

  if (violations.length > 0) {
    throw new Error(
      `Delivery target not in agent's tools.message.allowedChannels:\n  - ${violations.join("\n  - ")}`,
    );
  }
}

// (no extra exports)
