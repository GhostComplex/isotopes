// src/tools/subagent-management.ts — Tools for listing, inspecting, and cancelling subagent tasks
// Exposes TaskRegistry and cancelSubagent to agents as callable tools.

import type { Tool } from "../core/types.js";
import type { ToolHandler } from "../core/tools.js";
import { taskRegistry } from "../subagent/task-registry.js";
import { cancelSubagent } from "./subagent.js";

// ---------------------------------------------------------------------------
// subagents_list
// ---------------------------------------------------------------------------

/**
 * Create the `subagents_list` tool.
 *
 * Lists running subagent tasks, optionally filtered by session_id or
 * channel_id.
 */
export function createSubagentsListTool(): { tool: Tool; handler: ToolHandler } {
  return {
    tool: {
      name: "subagents_list",
      description:
        "List running subagent tasks. Optionally filter by session_id or channel_id.",
      parameters: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "Filter by session ID",
          },
          channel_id: {
            type: "string",
            description: "Filter by channel ID",
          },
        },
      },
    },
    handler: async (args) => {
      const { session_id, channel_id } = args as {
        session_id?: string;
        channel_id?: string;
      };

      let tasks = taskRegistry.list();

      if (session_id) {
        tasks = tasks.filter((t) => t.sessionId === session_id);
      }
      if (channel_id) {
        tasks = tasks.filter((t) => t.channelId === channel_id);
      }

      return JSON.stringify({
        tasks: tasks.map((t) => ({
          task_id: t.taskId,
          session_id: t.sessionId,
          channel_id: t.channelId,
          started_at: t.startedAt.toISOString(),
          running_seconds: Math.floor((Date.now() - t.startedAt.getTime()) / 1000),
        })),
        count: tasks.length,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// subagents_status
// ---------------------------------------------------------------------------

/**
 * Create the `subagents_status` tool.
 *
 * Returns detailed status of a specific subagent task by task_id.
 */
export function createSubagentsStatusTool(): { tool: Tool; handler: ToolHandler } {
  return {
    tool: {
      name: "subagents_status",
      description:
        "Get status of a specific subagent task by task_id.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Task ID to query",
          },
        },
        required: ["task_id"],
      },
    },
    handler: async (args) => {
      const { task_id } = args as { task_id: string };

      const task = taskRegistry.get(task_id);
      if (!task) {
        return JSON.stringify({
          found: false,
          task_id,
          status: "unknown",
        });
      }

      return JSON.stringify({
        found: true,
        task_id: task.taskId,
        status: "running",
        session_id: task.sessionId,
        channel_id: task.channelId,
        started_at: task.startedAt.toISOString(),
        running_seconds: Math.floor((Date.now() - task.startedAt.getTime()) / 1000),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// subagents_cancel
// ---------------------------------------------------------------------------

/**
 * Create the `subagents_cancel` tool.
 *
 * Cancels a running subagent task by task_id.
 */
export function createSubagentsCancelTool(): { tool: Tool; handler: ToolHandler } {
  return {
    tool: {
      name: "subagents_cancel",
      description:
        "Cancel a running subagent task by task_id.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Task ID to cancel",
          },
        },
        required: ["task_id"],
      },
    },
    handler: async (args) => {
      const { task_id } = args as { task_id: string };

      const task = taskRegistry.get(task_id);
      if (!task) {
        return JSON.stringify({
          cancelled: false,
          task_id,
          reason: "task not found",
        });
      }

      const success = cancelSubagent(task_id);
      return JSON.stringify({
        cancelled: success,
        task_id,
      });
    },
  };
}
