import type { Hono } from "hono";
import type { CronJobInput } from "../automation/cron-job.js";
import type { RouteDeps } from "./server.js";

export function registerCronRoutes(app: Hono, deps: RouteDeps): void {
  app.get("/api/cron", (c) => {
    const jobs = deps.cronScheduler.listJobs();
    return c.json({
      items: jobs.map((j) => ({
        id: j.id,
        name: j.name,
        expression: j.expression,
        agentId: j.agentId,
        action: j.action,
        enabled: j.enabled,
        lastRun: j.lastRun?.toISOString() ?? null,
        nextRun: j.nextRun?.toISOString() ?? null,
        createdAt: j.createdAt.toISOString(),
      })),
    });
  });

  app.post("/api/cron", async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as Partial<CronJobInput> | undefined;
    if (!body || typeof body.name !== "string" || typeof body.expression !== "string" || typeof body.agentId !== "string") {
      return c.json({ error: "Request body must include 'name', 'expression', and 'agentId'", status: 400 }, 400);
    }
    if (!body.action || typeof body.action.type !== "string") {
      return c.json({ error: "Request body must include 'action' with a 'type' field", status: 400 }, 400);
    }
    const job = deps.cronScheduler.register({
      name: body.name,
      expression: body.expression,
      agentId: body.agentId,
      action: body.action as CronJobInput["action"],
      enabled: body.enabled ?? true,
    });
    return c.json(
      {
        id: job.id,
        name: job.name,
        expression: job.expression,
        agentId: job.agentId,
        enabled: job.enabled,
        nextRun: job.nextRun?.toISOString() ?? null,
        createdAt: job.createdAt.toISOString(),
      },
      201,
    );
  });

  app.delete("/api/cron/:id", (c) => {
    const removed = deps.cronScheduler.unregister(c.req.param("id"));
    if (!removed) {
      return c.json({ error: `Cron job "${c.req.param("id")}" not found`, status: 404 }, 404);
    }
    return c.json({ ok: true });
  });
}
