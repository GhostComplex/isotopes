// src/api/status.ts — GET /api/status

import { addRoute } from "./routes.js";
import { sendJson } from "./middleware.js";
import { VERSION } from "../version.js";

addRoute("GET", "/api/status", (_req, res, deps) => {
  const cronJobCount = deps.cronScheduler.listJobs().length;

  sendJson(res, 200, {
    version: VERSION,
    uptime: process.uptime(),
    cronJobs: cronJobCount,
  });
});
