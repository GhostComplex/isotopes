// src/api/config.ts — Configuration routes

import { addRoute } from "./routes.js";
import { sendJson, sendError } from "./middleware.js";

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
// PUT /api/config — trigger config hot-reload
// ---------------------------------------------------------------------------

addRoute("PUT", "/api/config", (_req, res, deps) => {
  if (!deps.configReloader) {
    sendError(res, 501, "Config reloader not available");
    return;
  }

  const config = deps.configReloader.getConfig();
  if (!config) {
    sendError(res, 503, "Config not yet loaded");
    return;
  }

  sendJson(res, 200, { ok: true, config });
});
