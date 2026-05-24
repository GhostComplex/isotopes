import type { Hono } from "hono";
import { VERSION } from "../utils/version.js";
import type { ApiDeps } from "./server.js";

export function registerStatusRoutes(app: Hono, deps: ApiDeps): void {
  app.get("/api/status", (c) => {
    return c.json({
      version: VERSION,
      uptime: process.uptime(),
      cronJobs: deps.cronScheduler.listJobs().length,
    });
  });
}
