// src/api/spawn-agents.ts — Spawn agent management API routes
// GET    /api/spawn-agents      — list running spawn agent tasks
// DELETE /api/spawn-agents/:id  — cancel a running spawn agent

import { addRoute } from "./routes.js";
import { sendJson, sendError } from "./middleware.js";
import { taskRegistry } from "../agents/task-registry.js";
import { cancelAgent } from "../tools/spawn-agent.js";

// ---------------------------------------------------------------------------
// GET /api/spawn-agents — list running spawn agents
// ---------------------------------------------------------------------------

addRoute("GET", "/api/spawn-agents", (_req, res) => {
  sendJson(res, 200, { items: taskRegistry.list() });
});

// ---------------------------------------------------------------------------
// DELETE /api/spawn-agents/:id — cancel a running spawn agent
// ---------------------------------------------------------------------------

addRoute("DELETE", "/api/spawn-agents/:id", (req, res) => {
  const { id } = req.params;

  const task = taskRegistry.get(id);
  if (!task) {
    sendError(res, 404, `Task "${id}" not found`);
    return;
  }

  cancelAgent(id);
  taskRegistry.unregister(id);

  sendJson(res, 200, { ok: true });
});
