// src/api/subagents.ts — Subagent management API routes
// GET    /api/subagents      — list running subagent tasks
// DELETE /api/subagents/:id  — cancel a running subagent

import { addRoute } from "./routes.js";
import { sendJson, sendError } from "./middleware.js";
import { taskRegistry } from "../subagent/task-registry.js";
import { cancelSubagent } from "../tools/subagent.js";

// ---------------------------------------------------------------------------
// GET /api/subagents — list running subagents
// ---------------------------------------------------------------------------

addRoute("GET", "/api/subagents", (_req, res) => {
  sendJson(res, 200, { items: taskRegistry.list() });
});

// ---------------------------------------------------------------------------
// DELETE /api/subagents/:id — cancel a running subagent
// ---------------------------------------------------------------------------

addRoute("DELETE", "/api/subagents/:id", (req, res) => {
  const { id } = req.params;

  const task = taskRegistry.get(id);
  if (!task) {
    sendError(res, 404, `Task "${id}" not found`);
    return;
  }

  cancelSubagent(id);
  taskRegistry.unregister(id);

  sendJson(res, 200, { ok: true });
});
