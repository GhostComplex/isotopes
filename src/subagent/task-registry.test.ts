// src/subagent/task-registry.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import { TaskRegistry } from "./task-registry.js";

describe("TaskRegistry", () => {
  let registry: TaskRegistry;

  beforeEach(() => {
    registry = new TaskRegistry();
  });

  describe("register()", () => {
    it("adds a task", () => {
      registry.register("task-1", "sess-1", "chan-1");
      const task = registry.get("task-1");
      expect(task).toBeDefined();
      expect(task!.taskId).toBe("task-1");
      expect(task!.sessionId).toBe("sess-1");
      expect(task!.channelId).toBe("chan-1");
      expect(task!.startedAt).toBeInstanceOf(Date);
    });

    it("overwrites existing task with same id", () => {
      registry.register("task-1", "sess-1", "chan-1");
      registry.register("task-1", "sess-2", "chan-2");
      const task = registry.get("task-1");
      expect(task!.sessionId).toBe("sess-2");
    });
  });

  describe("unregister()", () => {
    it("removes a task", () => {
      registry.register("task-1", "sess-1", "chan-1");
      registry.unregister("task-1");
      expect(registry.get("task-1")).toBeUndefined();
    });

    it("is a no-op for unknown taskId", () => {
      expect(() => registry.unregister("nonexistent")).not.toThrow();
    });
  });

  describe("get()", () => {
    it("returns the correct task", () => {
      registry.register("task-1", "sess-1", "chan-1");
      registry.register("task-2", "sess-2", "chan-2");
      expect(registry.get("task-1")!.sessionId).toBe("sess-1");
      expect(registry.get("task-2")!.sessionId).toBe("sess-2");
    });

    it("returns undefined for unknown taskId", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });
  });

  describe("getBySession()", () => {
    it("filters tasks by sessionId", () => {
      registry.register("task-1", "sess-1", "chan-1");
      registry.register("task-2", "sess-1", "chan-2");
      registry.register("task-3", "sess-2", "chan-1");

      const sess1Tasks = registry.getBySession("sess-1");
      expect(sess1Tasks).toHaveLength(2);
      expect(sess1Tasks.map((t) => t.taskId).sort()).toEqual(["task-1", "task-2"]);
    });

    it("returns empty array for unknown session", () => {
      expect(registry.getBySession("nonexistent")).toEqual([]);
    });
  });

  describe("list()", () => {
    it("returns all tasks", () => {
      registry.register("task-1", "sess-1", "chan-1");
      registry.register("task-2", "sess-2", "chan-2");
      expect(registry.list()).toHaveLength(2);
    });

    it("returns empty array when no tasks", () => {
      expect(registry.list()).toEqual([]);
    });
  });
});
