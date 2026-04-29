// src/plugins/http/usage.ts — Global usage stats route

import { addRoute } from "./routes.js";
import { sendJson } from "./middleware.js";

// ---------------------------------------------------------------------------
// GET /api/usage — global usage stats
// ---------------------------------------------------------------------------

addRoute("GET", "/api/usage", (_req, res, deps) => {
  sendJson(res, 200, deps.usageTracker?.getGlobal() ?? { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
});
