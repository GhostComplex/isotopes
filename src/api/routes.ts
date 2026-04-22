// src/api/routes.ts — REST route handlers for the Isotopes API
// Implements GET/POST/PUT/DELETE endpoints for sessions, cron, config, and status.

import type { ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";

import { VERSION } from "../version.js";
import type { CronScheduler, CronJobInput } from "../automation/cron-job.js";
import type { ConfigReloader } from "../workspace/config-reloader.js";
import type { DefaultAgentManager } from "../core/agent-manager.js";
import type { SessionStore } from "../core/types.js";
import { messageText } from "../core/messages.js";
import type { UsageTracker } from "../core/usage-tracker.js";
import type { SessionStoreManager } from "../core/session-store-manager.js";
import type { HookRegistry } from "../plugins/hooks.js";
import { getIsotopesHome, getLogsDir } from "../core/paths.js";
import { sendJson, sendError, handleRouteError, type ApiRequest } from "./middleware.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected into route handlers. */
export interface RouteDeps {
  cronScheduler: CronScheduler;
  configReloader?: ConfigReloader;
  agentManager?: DefaultAgentManager;
  discordSessionStores?: Map<string, SessionStore>;
  usageTracker?: UsageTracker;
  sessionStoreManager?: SessionStoreManager;
  hooks?: HookRegistry;
}

/** Handler function for a matched API route. */
export type RouteHandler = (
  req: ApiRequest,
  res: ServerResponse,
  deps: RouteDeps,
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

// ---------------------------------------------------------------------------
// Route registry
// ---------------------------------------------------------------------------

const routes: Route[] = [];

export function addRoute(method: string, path: string, handler: RouteHandler): void {
  // Convert "/api/sessions/:id" → regex with named capture groups
  const paramNames: string[] = [];
  const regexStr = path.replace(/:([a-zA-Z_]+)/g, (_match, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  routes.push({
    method,
    pattern: new RegExp(`^${regexStr}$`),
    paramNames,
    handler,
  });
}

/**
 * Match an incoming request to a registered route.
 * Returns the matched route and extracted params, or undefined.
 */
export function matchRoute(
  method: string,
  pathname: string,
): { handler: RouteHandler; params: Record<string, string> } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = pathname.match(route.pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]);
    });

    return { handler: route.handler, params };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// GET /api/status — daemon status
// ---------------------------------------------------------------------------

addRoute("GET", "/api/status", (_req, res, deps) => {
  const cronJobCount = deps.cronScheduler.listJobs().length;

  sendJson(res, 200, {
    version: VERSION,
    uptime: process.uptime(),
    cronJobs: cronJobCount,
  });
});

// ---------------------------------------------------------------------------
// GET /api/sessions — list all sessions
// ---------------------------------------------------------------------------

addRoute("GET", "/api/sessions", async (_req, res, deps) => {
  const discordSessions: Array<{
    id: string;
    key?: string;
    agentId: string;
    threadId: string | undefined;
    channelName?: string;
    guildName?: string;
    status: string;
    createdAt: string;
    lastActivityAt: string;
    messageCount: number;
    source: string;
  }> = [];
  if (deps.discordSessionStores) {
    for (const [agentId, store] of deps.discordSessionStores) {
      const sessions = await store.list();
      for (const s of sessions) {
        discordSessions.push({
          id: s.id,
          key: s.metadata?.key,
          agentId: s.agentId || agentId,
          threadId: s.metadata?.threadId,
          channelName: s.metadata?.channelName,
          guildName: s.metadata?.guildName,
          status: "active",
          createdAt: s.lastActiveAt.toISOString(),
          lastActivityAt: s.lastActiveAt.toISOString(),
          messageCount: 0,
          source: "discord",
        });
      }
    }
  }

  sendJson(res, 200, discordSessions);
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:id — get session details
// ---------------------------------------------------------------------------

addRoute("GET", "/api/sessions/:id", async (req, res, deps) => {
  if (deps.discordSessionStores) {
    for (const store of deps.discordSessionStores.values()) {
      const discordSession = await store.get(req.params.id);
      if (discordSession) {
        const messages = await store.getMessages(req.params.id);
        sendJson(res, 200, {
          id: discordSession.id,
          agentId: discordSession.agentId,
          threadId: discordSession.metadata?.threadId,
          status: "active",
          createdAt: discordSession.lastActiveAt.toISOString(),
          lastActivityAt: discordSession.lastActiveAt.toISOString(),
          source: "discord",
          history: messages.map((m) => ({
            role: m.role,
            content: messageText(m),
            timestamp: "timestamp" in m && typeof m.timestamp === "number"
              ? new Date(m.timestamp).toISOString() : undefined,
          })),
        });
        return;
      }
    }
  }

  sendError(res, 404, `Session "${req.params.id}" not found`);
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:id/messages — get session messages
// ---------------------------------------------------------------------------

addRoute("GET", "/api/sessions/:id/messages", async (req, res, deps) => {
  if (deps.discordSessionStores) {
    for (const store of deps.discordSessionStores.values()) {
      const discordSession = await store.get(req.params.id);
      if (discordSession) {
        const messages = await store.getMessages(req.params.id);
        sendJson(res, 200, {
          messages: messages.map((m) => ({
            role: m.role,
            content: messageText(m),
            timestamp: "timestamp" in m && typeof m.timestamp === "number"
              ? new Date(m.timestamp).toISOString() : undefined,
          })),
        });
        return;
      }
    }
  }

  sendError(res, 404, `Session "${req.params.id}" not found`);
});

// ---------------------------------------------------------------------------
// GET /api/cron — list cron jobs
// ---------------------------------------------------------------------------

addRoute("GET", "/api/cron", (_req, res, deps) => {
  const jobs = deps.cronScheduler.listJobs();

  sendJson(
    res,
    200,
    jobs.map((j) => ({
      id: j.id,
      name: j.name,
      expression: j.expression,
      agentId: j.agentId,
      channelId: j.channelId,
      action: j.action,
      enabled: j.enabled,
      lastRun: j.lastRun?.toISOString() ?? null,
      nextRun: j.nextRun?.toISOString() ?? null,
      createdAt: j.createdAt.toISOString(),
    })),
  );
});

// ---------------------------------------------------------------------------
// POST /api/cron — create cron job
// ---------------------------------------------------------------------------

addRoute("POST", "/api/cron", (req, res, deps) => {
  const body = req.body as Partial<CronJobInput> | undefined;
  if (!body || typeof body.name !== "string" || typeof body.expression !== "string" || typeof body.agentId !== "string") {
    sendError(res, 400, "Request body must include 'name', 'expression', and 'agentId'");
    return;
  }

  if (!body.action || typeof body.action.type !== "string") {
    sendError(res, 400, "Request body must include 'action' with a 'type' field");
    return;
  }

  try {
    const job = deps.cronScheduler.register({
      name: body.name,
      expression: body.expression,
      agentId: body.agentId,
      channelId: body.channelId,
      action: body.action as CronJobInput["action"],
      enabled: body.enabled ?? true,
    });

    sendJson(res, 201, {
      id: job.id,
      name: job.name,
      expression: job.expression,
      agentId: job.agentId,
      enabled: job.enabled,
      nextRun: job.nextRun?.toISOString() ?? null,
      createdAt: job.createdAt.toISOString(),
    });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/cron/:id — delete cron job
// ---------------------------------------------------------------------------

addRoute("DELETE", "/api/cron/:id", (req, res, deps) => {
  const removed = deps.cronScheduler.unregister(req.params.id);
  if (!removed) {
    sendError(res, 404, `Cron job "${req.params.id}" not found`);
    return;
  }

  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/config — get current config
// ---------------------------------------------------------------------------

addRoute("GET", "/api/config", (_req, res, deps) => {
  if (!deps.configReloader) {
    sendError(res, 501, "Config reloader not available");
    return;
  }

  const config = deps.configReloader.getConfig();
  if (!config) {
    sendError(res, 503, "Config not yet loaded");
    return;
  }

  sendJson(res, 200, config);
});

// ---------------------------------------------------------------------------
// GET /api/logs — tail log file
// ---------------------------------------------------------------------------

const LOG_CANDIDATES = [
  () => path.join(getLogsDir(), "isotopes.log"),
  () => path.join(getLogsDir(), "isotopes.out.log"),
  () => path.join(getIsotopesHome(), "isotopes.log"),
];

async function findLogFile(): Promise<string | null> {
  for (const getPath of LOG_CANDIDATES) {
    const p = getPath();
    try {
      await access(p, constants.R_OK);
      return p;
    } catch {
      // try next
    }
  }
  return null;
}

function tailFile(filePath: string, lines: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tail", ["-n", lines, filePath], (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

addRoute("GET", "/api/logs", async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const lines = url.searchParams.get("lines") ?? "100";

  const logPath = await findLogFile();
  if (!logPath) {
    sendJson(res, 200, { logs: "(no log file found)", file: null });
    return;
  }

  try {
    const logs = await tailFile(logPath, lines);
    sendJson(res, 200, { logs, file: logPath });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/usage — global usage stats
// ---------------------------------------------------------------------------

addRoute("GET", "/api/usage", (_req, res, deps) => {
  sendJson(res, 200, deps.usageTracker?.getGlobal() ?? { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:id/usage — per-session usage stats
// ---------------------------------------------------------------------------

addRoute("GET", "/api/sessions/:id/usage", (req, res, deps) => {
  sendJson(res, 200, deps.usageTracker?.getSession(req.params.id) ?? { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
});

// ---------------------------------------------------------------------------
// PUT /api/config — update config (triggers hot-reload)
// ---------------------------------------------------------------------------

addRoute("PUT", "/api/config", (_req, res, deps) => {
  if (!deps.configReloader) {
    sendError(res, 501, "Config reloader not available");
    return;
  }

  // The config reloader watches the file system — the PUT endpoint signals
  // that the caller has already written new config to disk and wants to
  // trigger an immediate reload.  We don't accept a body here because the
  // source of truth is the config file itself.

  const config = deps.configReloader.getConfig();
  if (!config) {
    sendError(res, 503, "Config not yet loaded");
    return;
  }

  // The watcher will pick up the file change and reload automatically.
  // We return the current config as acknowledgement.
  sendJson(res, 200, { ok: true, config });
});
