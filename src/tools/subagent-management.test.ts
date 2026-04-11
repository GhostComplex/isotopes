// src/tools/subagent-management.test.ts — Tests for subagent management tools

import { describe, it, expect, beforeEach, vi } from "vitest";
import { taskRegistry } from "../subagent/task-registry.js";
import {
  createSubagentsListTool,
  createSubagentsStatusTool,
  createSubagentsCancelTool,
} from "./subagent-management.js";

vi.mock("./subagent.js", () => ({
  cancelSubagent: vi.fn(() => true),
}));

// Access the mock for assertions
import { cancelSubagent } from "./subagent.js";
const cancelSubagentMock = vi.mocked(cancelSubagent);

beforeEach(() => {
  // Clear the task registry between tests
  for (const task of taskRegistry.list()) {
    taskRegistry.unregister(task.taskId);
  }
  cancelSubagentMock.mockClear();
});

// ---------------------------------------------------------------------------
// subagents_list
// ---------------------------------------------------------------------------

describe("subagents_list", () => {
  it("returns tool with correct schema", () => {
    const { tool } = createSubagentsListTool();
    expect(tool.name).toBe("subagents_list");
    expect(tool.parameters.properties).toHaveProperty("session_id");
    expect(tool.parameters.properties).toHaveProperty("channel_id");
  });

  it("returns empty list when no tasks", async () => {
    const { handler } = createSubagentsListTool();
    const result = JSON.parse(await handler({}));

    expect(result.tasks).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("lists all running tasks", async () => {
    taskRegistry.register("task-1", "session-a", "channel-1");
    taskRegistry.register("task-2", "session-b", "channel-2");

    const { handler } = createSubagentsListTool();
    const result = JSON.parse(await handler({}));

    expect(result.count).toBe(2);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].task_id).toBe("task-1");
    expect(result.tasks[0].session_id).toBe("session-a");
    expect(result.tasks[0].channel_id).toBe("channel-1");
    expect(result.tasks[0]).toHaveProperty("started_at");
    expect(result.tasks[0]).toHaveProperty("running_seconds");
    expect(result.tasks[1].task_id).toBe("task-2");
  });

  it("filters by session_id", async () => {
    taskRegistry.register("task-1", "session-a", "channel-1");
    taskRegistry.register("task-2", "session-b", "channel-2");
    taskRegistry.register("task-3", "session-a", "channel-3");

    const { handler } = createSubagentsListTool();
    const result = JSON.parse(await handler({ session_id: "session-a" }));

    expect(result.count).toBe(2);
    expect(result.tasks.every((t: { session_id: string }) => t.session_id === "session-a")).toBe(true);
  });

  it("filters by channel_id", async () => {
    taskRegistry.register("task-1", "session-a", "channel-1");
    taskRegistry.register("task-2", "session-b", "channel-1");
    taskRegistry.register("task-3", "session-a", "channel-2");

    const { handler } = createSubagentsListTool();
    const result = JSON.parse(await handler({ channel_id: "channel-1" }));

    expect(result.count).toBe(2);
    expect(result.tasks.every((t: { channel_id: string }) => t.channel_id === "channel-1")).toBe(true);
  });

  it("filters by both session_id and channel_id", async () => {
    taskRegistry.register("task-1", "session-a", "channel-1");
    taskRegistry.register("task-2", "session-a", "channel-2");
    taskRegistry.register("task-3", "session-b", "channel-1");

    const { handler } = createSubagentsListTool();
    const result = JSON.parse(await handler({ session_id: "session-a", channel_id: "channel-1" }));

    expect(result.count).toBe(1);
    expect(result.tasks[0].task_id).toBe("task-1");
  });
});

// ---------------------------------------------------------------------------
// subagents_status
// ---------------------------------------------------------------------------

describe("subagents_status", () => {
  it("returns tool with correct schema", () => {
    const { tool } = createSubagentsStatusTool();
    expect(tool.name).toBe("subagents_status");
    expect(tool.parameters.required).toContain("task_id");
  });

  it("returns status of a running task", async () => {
    taskRegistry.register("task-1", "session-a", "channel-1");

    const { handler } = createSubagentsStatusTool();
    const result = JSON.parse(await handler({ task_id: "task-1" }));

    expect(result.found).toBe(true);
    expect(result.task_id).toBe("task-1");
    expect(result.status).toBe("running");
    expect(result.session_id).toBe("session-a");
    expect(result.channel_id).toBe("channel-1");
    expect(result).toHaveProperty("started_at");
    expect(result).toHaveProperty("running_seconds");
  });

  it("returns not found for unknown task", async () => {
    const { handler } = createSubagentsStatusTool();
    const result = JSON.parse(await handler({ task_id: "nonexistent" }));

    expect(result.found).toBe(false);
    expect(result.task_id).toBe("nonexistent");
    expect(result.status).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// subagents_cancel
// ---------------------------------------------------------------------------

describe("subagents_cancel", () => {
  it("returns tool with correct schema", () => {
    const { tool } = createSubagentsCancelTool();
    expect(tool.name).toBe("subagents_cancel");
    expect(tool.parameters.required).toContain("task_id");
  });

  it("cancels a running task", async () => {
    taskRegistry.register("task-1", "session-a", "channel-1");

    const { handler } = createSubagentsCancelTool();
    const result = JSON.parse(await handler({ task_id: "task-1" }));

    expect(result.cancelled).toBe(true);
    expect(result.task_id).toBe("task-1");
    expect(cancelSubagentMock).toHaveBeenCalledWith("task-1");
  });

  it("returns not found for unknown task", async () => {
    const { handler } = createSubagentsCancelTool();
    const result = JSON.parse(await handler({ task_id: "nonexistent" }));

    expect(result.cancelled).toBe(false);
    expect(result.task_id).toBe("nonexistent");
    expect(result.reason).toBe("task not found");
    expect(cancelSubagentMock).not.toHaveBeenCalled();
  });

  it("reports failure when cancelSubagent returns false", async () => {
    taskRegistry.register("task-1", "session-a", "channel-1");
    cancelSubagentMock.mockReturnValueOnce(false);

    const { handler } = createSubagentsCancelTool();
    const result = JSON.parse(await handler({ task_id: "task-1" }));

    expect(result.cancelled).toBe(false);
    expect(result.task_id).toBe("task-1");
  });
});
