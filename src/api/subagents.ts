// src/api/subagents.ts — Subagent management API routes
// GET    /api/subagents          — list running subagent tasks
// DELETE /api/subagents/:taskId  — cancel a running subagent

import { addRoute } from "./routes.js";
import { sendJson, sendError } from "./middleware.js";
import { taskRegistry } from "../subagent/task-registry.js";
import { cancelSubagent } from "../tools/subagent.js";

// ---------------------------------------------------------------------------
// GET /api/subagents — list running subagents
// ---------------------------------------------------------------------------

addRoute("GET", "/api/subagents", (_req, res) => {
  sendJson(res, 200, { tasks: taskRegistry.list() });
});

// ---------------------------------------------------------------------------
// DELETE /api/subagents/:taskId — cancel a running subagent
// ---------------------------------------------------------------------------

addRoute("DELETE", "/api/subagents/:taskId", (req, res) => {
  const { taskId } = req.params;

  const task = taskRegistry.get(taskId);
  if (!task) {
    sendError(res, 404, `Task "${taskId}" not found`);
    return;
  }

  cancelSubagent(taskId);
  taskRegistry.unregister(taskId);

  sendJson(res, 200, { cancelled: true, taskId });
});
