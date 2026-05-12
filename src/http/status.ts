// src/http/status.ts — GET /api/status

import type { Hono } from "hono";
import { VERSION } from "../legacy/version.js";
import type { RouteDeps } from "./server.js";

export function registerStatusRoutes(app: Hono, deps: RouteDeps): void {
  app.get("/api/status", (c) => {
    return c.json({
      version: VERSION,
      uptime: process.uptime(),
      cronJobs: deps.cronScheduler.listJobs().length,
    });
  });
}
