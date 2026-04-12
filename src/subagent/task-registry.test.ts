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
      registry.register("task-1", "sess-1", "chan-1", "do something");
      const task = registry.get("task-1");
      expect(task).toBeDefined();
      expect(task!.taskId).toBe("task-1");
      expect(task!.sessionId).toBe("sess-1");
      expect(task!.channelId).toBe("chan-1");
      expect(task!.task).toBe("do something");
      expect(task!.startedAt).toBeInstanceOf(Date);
    });

    it("overwrites existing task with same id", () => {
      registry.register("task-1", "sess-1", "chan-1", "task A");
      registry.register("task-1", "sess-2", "chan-2", "task B");
      const task = registry.get("task-1");
      expect(task!.sessionId).toBe("sess-2");
      expect(task!.task).toBe("task B");
    });
  });

  describe("unregister()", () => {
    it("removes a task", () => {
      registry.register("task-1", "sess-1", "chan-1", "do something");
      registry.unregister("task-1");
      expect(registry.get("task-1")).toBeUndefined();
    });

    it("is a no-op for unknown taskId", () => {
      expect(() => registry.unregister("nonexistent")).not.toThrow();
    });
  });

  describe("get()", () => {
    it("returns the correct task", () => {
      registry.register("task-1", "sess-1", "chan-1", "task A");
      registry.register("task-2", "sess-2", "chan-2", "task B");
      expect(registry.get("task-1")!.sessionId).toBe("sess-1");
      expect(registry.get("task-2")!.sessionId).toBe("sess-2");
    });

    it("returns undefined for unknown taskId", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });
  });

  describe("getBySession()", () => {
    it("filters tasks by sessionId", () => {
      registry.register("task-1", "sess-1", "chan-1", "task A");
      registry.register("task-2", "sess-1", "chan-2", "task B");
      registry.register("task-3", "sess-2", "chan-1", "task C");

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
      registry.register("task-1", "sess-1", "chan-1", "task A");
      registry.register("task-2", "sess-2", "chan-2", "task B");
      expect(registry.list()).toHaveLength(2);
    });

    it("returns empty array when no tasks", () => {
      expect(registry.list()).toEqual([]);
    });
  });

  describe("setThreadId()", () => {
    it("sets threadId on existing task", () => {
      registry.register("task-1", "sess-1", "chan-1", "do something");
      registry.setThreadId("task-1", "thread-123");
      const task = registry.get("task-1");
      expect(task!.threadId).toBe("thread-123");
    });

    it("is a no-op for unknown taskId", () => {
      expect(() => registry.setThreadId("nonexistent", "thread-1")).not.toThrow();
    });
  });

  describe("getByThreadId()", () => {
    it("returns task with matching threadId", () => {
      registry.register("task-1", "sess-1", "chan-1", "do something");
      registry.setThreadId("task-1", "thread-123");
      
      const task = registry.getByThreadId("thread-123");
      expect(task).toBeDefined();
      expect(task!.taskId).toBe("task-1");
    });

    it("returns undefined when no task has that threadId", () => {
      registry.register("task-1", "sess-1", "chan-1", "do something");
      expect(registry.getByThreadId("thread-999")).toBeUndefined();
    });

    it("returns undefined when tasks have no threadId set", () => {
      registry.register("task-1", "sess-1", "chan-1", "do something");
      expect(registry.getByThreadId("thread-1")).toBeUndefined();
    });
  });
});
