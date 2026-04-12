// src/api/routes.ts — REST route handlers for the Isotopes API
// Implements GET/POST/PUT/DELETE endpoints for sessions, cron, config, and status.

import type { ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";

import { VERSION } from "../index.js";
import type { AcpSessionManager } from "../acp/session-manager.js";
import type { CronScheduler, CronJobInput } from "../automation/cron-job.js";
import type { ConfigReloader } from "../workspace/config-reloader.js";
import type { AgentManager, SessionStore } from "../core/types.js";
import type { UsageTracker } from "../core/usage-tracker.js";
import { getIsotopesHome, getLogsDir } from "../core/paths.js";
import { sendJson, sendError, handleRouteError, type ApiRequest } from "./middleware.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected into route handlers. */
export interface RouteDeps {
  sessionManager: AcpSessionManager;
  cronScheduler: CronScheduler;
  configReloader?: ConfigReloader;
  /** Agent manager for WebChat routes */
  agentManager?: AgentManager;
  /** Session store for WebChat routes */
  chatSessionStore?: SessionStore;
  /** Per-agent session stores for Discord sessions */
  discordSessionStores?: Map<string, SessionStore>;
  /** Usage tracker for token/cost accumulation */
  usageTracker?: UsageTracker;
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

addRoute("GET", "/api/sessions", async (_req, res, deps) => {
  // ACP sessions (in-memory)
  const acpSessions = deps.sessionManager.listSessions().map((s) => ({
    id: s.id,
    agentId: s.agentId,
    threadId: s.threadId,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
    lastActivityAt: s.lastActivityAt.toISOString(),
    messageCount: s.history.length,
    source: "acp" as const,
  }));

  // Chat sessions (file-persisted)
  let chatSessions: Array<{
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
  if (deps.chatSessionStore) {
    const sessions = await deps.chatSessionStore.list();
    chatSessions = sessions.map((s) => ({
      id: s.id,
      key: s.metadata?.key,
      agentId: s.agentId,
      threadId: s.metadata?.threadId,
      status: "active" as const,
      createdAt: s.lastActiveAt.toISOString(),
      lastActivityAt: s.lastActiveAt.toISOString(),
      messageCount: 0,
      source: "chat" as const,
    }));
  }

  // Discord sessions (per-agent file-persisted stores)
  const discordSessions: typeof chatSessions = [];
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

  sendJson(res, 200, [...acpSessions, ...chatSessions, ...discordSessions]);
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:id — get session details
// ---------------------------------------------------------------------------

addRoute("GET", "/api/sessions/:id", async (req, res, deps) => {
  // Try ACP session first
  const session = deps.sessionManager.getSession(req.params.id);
  if (session) {
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
    return;
  }

  // Try chat session store
  if (deps.chatSessionStore) {
    const chatSession = await deps.chatSessionStore.get(req.params.id);
    if (chatSession) {
      const messages = await deps.chatSessionStore.getMessages(req.params.id);
      sendJson(res, 200, {
        id: chatSession.id,
        agentId: chatSession.agentId,
        threadId: chatSession.metadata?.threadId,
        status: "active",
        createdAt: chatSession.lastActiveAt.toISOString(),
        lastActivityAt: chatSession.lastActiveAt.toISOString(),
        source: "chat",
        history: messages.map((m) => ({
          role: m.role,
          content: Array.isArray(m.content)
            ? m.content.map((b) => (typeof b === "string" ? b : (b as { text?: string }).text ?? JSON.stringify(b))).join("")
            : String(m.content),
          timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : undefined,
        })),
      });
      return;
    }
  }

  // Try Discord per-agent session stores
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
            content: Array.isArray(m.content)
              ? m.content.map((b) => (typeof b === "string" ? b : (b as { text?: string }).text ?? JSON.stringify(b))).join("")
              : String(m.content),
            timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : undefined,
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
  // Try ACP session first
  const acpSession = deps.sessionManager.getSession(req.params.id);
  if (acpSession) {
    sendJson(res, 200, {
      messages: acpSession.history.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        timestamp: m.timestamp.toISOString(),
      })),
    });
    return;
  }

  // Try chat session store
  if (deps.chatSessionStore) {
    const chatSession = await deps.chatSessionStore.get(req.params.id);
    if (chatSession) {
      const messages = await deps.chatSessionStore.getMessages(req.params.id);
      sendJson(res, 200, {
        messages: messages.map((m) => ({
          role: m.role,
          content: Array.isArray(m.content)
            ? m.content.map((b) => (typeof b === "string" ? b : (b as { text?: string }).text ?? JSON.stringify(b))).join("")
            : String(m.content),
          timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : undefined,
        })),
      });
      return;
    }
  }

  // Try Discord per-agent session stores
  if (deps.discordSessionStores) {
    for (const store of deps.discordSessionStores.values()) {
      const discordSession = await store.get(req.params.id);
      if (discordSession) {
        const messages = await store.getMessages(req.params.id);
        sendJson(res, 200, {
          messages: messages.map((m) => ({
            role: m.role,
            content: Array.isArray(m.content)
              ? m.content.map((b) => (typeof b === "string" ? b : (b as { text?: string }).text ?? JSON.stringify(b))).join("")
              : String(m.content),
            timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : undefined,
          })),
        });
        return;
      }
    }
  }

  sendError(res, 404, `Session "${req.params.id}" not found`);
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
