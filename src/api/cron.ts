// src/api/cron.ts — Cron job management routes

import { addRoute } from "./routes.js";
import { sendJson, sendError, handleRouteError } from "./middleware.js";
import type { CronJobInput } from "../automation/cron-job.js";

// ---------------------------------------------------------------------------
// GET /api/cron — list cron jobs
// ---------------------------------------------------------------------------

addRoute("GET", "/api/cron", (_req, res, deps) => {
  const jobs = deps.cronScheduler.listJobs();

  sendJson(
    res,
    200,
    {
      items: jobs.map((j) => ({
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
    },
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
