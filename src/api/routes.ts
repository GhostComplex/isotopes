// src/api/routes.ts — REST route handlers for the Isotopes API
// Implements GET/POST/PUT/DELETE endpoints for sessions, cron, config, and status.

import type { ServerResponse } from "node:http";
import type { AcpSessionManager } from "../acp/session-manager.js";
import type { CronScheduler, CronJobInput } from "../automation/cron-job.js";
import type { ConfigReloader } from "../workspace/config-reloader.js";
import type { ApiRequest } from "./middleware.js";
import { sendJson, sendError, handleRouteError } from "./middleware.js";
import { VERSION } from "../index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteDeps {
  sessionManager: AcpSessionManager;
  cronScheduler: CronScheduler;
  configReloader?: ConfigReloader;
}

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

function addRoute(method: string, path: string, handler: RouteHandler): void {
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
  const sessionCount = deps.sessionManager.listSessions().length;
  const cronJobCount = deps.cronScheduler.listJobs().length;

  sendJson(res, 200, {
    version: VERSION,
    uptime: process.uptime(),
    sessions: sessionCount,
    cronJobs: cronJobCount,
  });
});

// ---------------------------------------------------------------------------
// GET /api/sessions — list all sessions
// ---------------------------------------------------------------------------

addRoute("GET", "/api/sessions", (_req, res, deps) => {
  const sessions = deps.sessionManager.listSessions();

  sendJson(
    res,
    200,
    sessions.map((s) => ({
      id: s.id,
      agentId: s.agentId,
      threadId: s.threadId,
      status: s.status,
      createdAt: s.createdAt.toISOString(),
      lastActivityAt: s.lastActivityAt.toISOString(),
      messageCount: s.history.length,
    })),
  );
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:id — get session details
// ---------------------------------------------------------------------------

addRoute("GET", "/api/sessions/:id", (req, res, deps) => {
  const session = deps.sessionManager.getSession(req.params.id);
  if (!session) {
    sendError(res, 404, `Session "${req.params.id}" not found`);
    return;
  }

  sendJson(res, 200, {
    id: session.id,
    agentId: session.agentId,
    threadId: session.threadId,
    status: session.status,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    history: session.history.map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp.toISOString(),
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/message — send message to session
// ---------------------------------------------------------------------------

addRoute("POST", "/api/sessions/:id/message", (req, res, deps) => {
  const session = deps.sessionManager.getSession(req.params.id);
  if (!session) {
    sendError(res, 404, `Session "${req.params.id}" not found`);
    return;
  }

  const body = req.body as { role?: string; content?: string } | undefined;
  if (!body || typeof body.content !== "string" || !body.content) {
    sendError(res, 400, "Request body must include 'content' (string)");
    return;
  }

  const role = body.role === "assistant" || body.role === "system" ? body.role : "user";

  const added = deps.sessionManager.addMessage(req.params.id, {
    role,
    content: body.content,
  });

  if (!added) {
    sendError(res, 500, "Failed to add message");
    return;
  }

  sendJson(res, 201, { ok: true });
});

// ---------------------------------------------------------------------------
// DELETE /api/sessions/:id — terminate session
// ---------------------------------------------------------------------------

addRoute("DELETE", "/api/sessions/:id", (req, res, deps) => {
  const terminated = deps.sessionManager.terminateSession(req.params.id);
  if (!terminated) {
    sendError(res, 404, `Session "${req.params.id}" not found`);
    return;
  }

  sendJson(res, 200, { ok: true });
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
