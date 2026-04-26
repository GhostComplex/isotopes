// src/core/thread-bindings.test.ts — Unit tests for ThreadBindingManager

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ThreadBindingManager } from "./thread-bindings.js";

describe("ThreadBindingManager", () => {
  let manager: ThreadBindingManager;

  beforeEach(() => {
    manager = new ThreadBindingManager();
  });

  // ---------------------------------------------------------------------------
  // bind / get
  // ---------------------------------------------------------------------------

  describe("bind", () => {
    it("creates a binding and returns it with threadId and createdAt", () => {
      const result = manager.bind("thread-1", {
        parentChannelId: "channel-1",
        agentId: "agent-1",
      });

      expect(result.threadId).toBe("thread-1");
      expect(result.parentChannelId).toBe("channel-1");
      expect(result.agentId).toBe("agent-1");
      expect(result.createdAt).toBeInstanceOf(Date);
    });

    it("stores the binding for later retrieval", () => {
      manager.bind("thread-1", {
        parentChannelId: "channel-1",
        agentId: "agent-1",
      });

      const retrieved = manager.get("thread-1");
      expect(retrieved).toBeDefined();
      expect(retrieved!.threadId).toBe("thread-1");
      expect(retrieved!.agentId).toBe("agent-1");
    });

    it("preserves optional sessionId", () => {
      const result = manager.bind("thread-1", {
        parentChannelId: "channel-1",
        sessionId: "session-abc",
        agentId: "agent-1",
      });

      expect(result.sessionId).toBe("session-abc");
      expect(manager.get("thread-1")!.sessionId).toBe("session-abc");
    });

    it("replaces existing binding for the same threadId", () => {
      manager.bind("thread-1", {
        parentChannelId: "channel-1",
        agentId: "agent-1",
      });
      manager.bind("thread-1", {
        parentChannelId: "channel-2",
        agentId: "agent-2",
      });

      const retrieved = manager.get("thread-1");
      expect(retrieved!.parentChannelId).toBe("channel-2");
      expect(retrieved!.agentId).toBe("agent-2");
      expect(manager.size).toBe(1);
    });

    it("notifies listeners when a binding is created", () => {
      const listener = vi.fn();
      manager.onBind(listener);

      const result = manager.bind("thread-1", {
        parentChannelId: "channel-1",
        agentId: "agent-1",
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(result);
    });

    it("notifies multiple listeners", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      manager.onBind(listener1);
      manager.onBind(listener2);

      manager.bind("thread-1", {
        parentChannelId: "channel-1",
        agentId: "agent-1",
      });

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // get
  // ---------------------------------------------------------------------------

  describe("get", () => {
    it("returns undefined for unknown threadId", () => {
      expect(manager.get("nonexistent")).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // unbind
  // ---------------------------------------------------------------------------

  describe("unbind", () => {
    it("removes an existing binding and returns true", () => {
      manager.bind("thread-1", {
        parentChannelId: "channel-1",
        agentId: "agent-1",
      });

      const removed = manager.unbind("thread-1");
      expect(removed).toBe(true);
      expect(manager.get("thread-1")).toBeUndefined();
      expect(manager.size).toBe(0);
    });

    it("returns false when threadId does not exist", () => {
      const removed = manager.unbind("nonexistent");
      expect(removed).toBe(false);
    });

    it("notifies unbind listeners with binding and reason", () => {
      const listener = vi.fn();
      manager.onUnbind(listener);

      const binding = manager.bind("thread-1", {
        parentChannelId: "channel-1",
        agentId: "agent-1",
      });

      manager.unbind("thread-1", "subagent-complete");

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(binding, "subagent-complete");
    });

    it("notifies multiple unbind listeners", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      manager.onUnbind(listener1);
      manager.onUnbind(listener2);

      manager.bind("thread-1", {
        parentChannelId: "channel-1",
        agentId: "agent-1",
      });

      manager.unbind("thread-1");

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it("does not notify unbind listeners when binding does not exist", () => {
      const listener = vi.fn();
      manager.onUnbind(listener);

      manager.unbind("nonexistent");

      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // size
  // ---------------------------------------------------------------------------

  describe("size", () => {
    it("returns 0 for empty manager", () => {
      expect(manager.size).toBe(0);
    });

    it("reflects the number of bindings", () => {
      manager.bind("thread-1", { parentChannelId: "c1", agentId: "a1" });
      manager.bind("thread-2", { parentChannelId: "c2", agentId: "a2" });
      expect(manager.size).toBe(2);
    });

    it("decrements after unbind", () => {
      manager.bind("thread-1", { parentChannelId: "c1", agentId: "a1" });
      manager.bind("thread-2", { parentChannelId: "c2", agentId: "a2" });
      manager.unbind("thread-1");
      expect(manager.size).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // onBind / unsubscribe
  // ---------------------------------------------------------------------------

  describe("onBind", () => {
    it("returns an unsubscribe function", () => {
      const listener = vi.fn();
      const unsubscribe = manager.onBind(listener);

      manager.bind("thread-1", { parentChannelId: "c1", agentId: "a1" });
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();

      manager.bind("thread-2", { parentChannelId: "c2", agentId: "a2" });
      expect(listener).toHaveBeenCalledTimes(1); // not called again
    });
  });

  // ---------------------------------------------------------------------------
  // onUnbind / unsubscribe
  // ---------------------------------------------------------------------------

  describe("onUnbind", () => {
    it("returns an unsubscribe function", () => {
      const listener = vi.fn();
      const unsubscribe = manager.onUnbind(listener);

      manager.bind("thread-1", { parentChannelId: "c1", agentId: "a1" });
      manager.unbind("thread-1");
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();

      manager.bind("thread-2", { parentChannelId: "c2", agentId: "a2" });
      manager.unbind("thread-2");
      expect(listener).toHaveBeenCalledTimes(1); // not called again
    });
  });

  // ---------------------------------------------------------------------------
  // clearAll
  // ---------------------------------------------------------------------------

  describe("clearAll", () => {
    it("removes all bindings", async () => {
      manager.bind("thread-1", { parentChannelId: "c1", agentId: "a1" });
      manager.bind("thread-2", { parentChannelId: "c2", agentId: "a2" });
      manager.bind("thread-3", { parentChannelId: "c3", agentId: "a3" });

      const count = await manager.clearAll();

      expect(count).toBe(3);
      expect(manager.size).toBe(0);
      expect(manager.get("thread-1")).toBeUndefined();
      expect(manager.get("thread-2")).toBeUndefined();
      expect(manager.get("thread-3")).toBeUndefined();
    });

    it("returns 0 when no bindings exist", async () => {
      const count = await manager.clearAll();
      expect(count).toBe(0);
    });

    it("notifies unbind listeners for each binding", async () => {
      const listener = vi.fn();
      manager.onUnbind(listener);

      manager.bind("thread-1", { parentChannelId: "c1", agentId: "a1" });
      manager.bind("thread-2", { parentChannelId: "c2", agentId: "a2" });

      await manager.clearAll("startup cleanup");

      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener.mock.calls[0][1]).toBe("startup cleanup");
      expect(listener.mock.calls[1][1]).toBe("startup cleanup");
    });

    it("saves empty array to persist file", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "thread-bindings-"));
      const persistPath = path.join(tmpDir, "bindings.json");

      const mgr = new ThreadBindingManager({ persistPath });
      mgr.bind("thread-1", { parentChannelId: "c1", agentId: "a1" });
      mgr.bind("thread-2", { parentChannelId: "c2", agentId: "a2" });

      await new Promise((r) => setTimeout(r, 50)); // wait for save

      await mgr.clearAll();

      const data = await fs.readFile(persistPath, "utf-8");
      const parsed = JSON.parse(data);
      expect(parsed).toEqual([]);

      await fs.rm(tmpDir, { recursive: true });
    });
  });

  // ---------------------------------------------------------------------------
  // all
  // ---------------------------------------------------------------------------

  describe("all", () => {
    it("returns all bindings as array", () => {
      manager.bind("thread-1", { parentChannelId: "c1", agentId: "a1" });
      manager.bind("thread-2", { parentChannelId: "c2", agentId: "a2" });

      const all = manager.all();

      expect(all).toHaveLength(2);
      expect(all.map((b) => b.threadId).sort()).toEqual(["thread-1", "thread-2"]);
    });

    it("returns empty array when no bindings", () => {
      expect(manager.all()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // persistence
  // ---------------------------------------------------------------------------

  describe("persistence", () => {
    it("should save bindings to file on bind", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "thread-bindings-"));
      const persistPath = path.join(tmpDir, "bindings.json");

      const mgr = new ThreadBindingManager({ persistPath });
      mgr.bind("thread-1", { parentChannelId: "channel-1", agentId: "agent-1" });

      // Wait for async save
      await new Promise((r) => setTimeout(r, 50));

      const data = await fs.readFile(persistPath, "utf-8");
      const parsed = JSON.parse(data);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].threadId).toBe("thread-1");

      // Cleanup
      await fs.rm(tmpDir, { recursive: true });
    });

    it("should load bindings from file", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "thread-bindings-"));
      const persistPath = path.join(tmpDir, "bindings.json");

      // Pre-create file
      await fs.writeFile(
        persistPath,
        JSON.stringify([
          {
            threadId: "thread-1",
            parentChannelId: "channel-1",
            agentId: "agent-1",
            createdAt: new Date().toISOString(),
          },
        ]),
      );

      const mgr = new ThreadBindingManager({ persistPath });
      await mgr.load();

      expect(mgr.size).toBe(1);
      expect(mgr.get("thread-1")?.agentId).toBe("agent-1");

      // Cleanup
      await fs.rm(tmpDir, { recursive: true });
    });

    it("should handle missing file gracefully", async () => {
      const mgr = new ThreadBindingManager({ persistPath: "/nonexistent/path.json" });
      await expect(mgr.load()).resolves.toBeUndefined();
    });

    it("should remove bindings from file on unbind", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "thread-bindings-"));
      const persistPath = path.join(tmpDir, "bindings.json");

      const mgr = new ThreadBindingManager({ persistPath });
      mgr.bind("thread-1", { parentChannelId: "channel-1", agentId: "agent-1" });
      mgr.bind("thread-2", { parentChannelId: "channel-2", agentId: "agent-2" });

      // Wait for async save
      await new Promise((r) => setTimeout(r, 50));

      mgr.unbind("thread-1");

      // Wait for async save
      await new Promise((r) => setTimeout(r, 50));

      const data = await fs.readFile(persistPath, "utf-8");
      const parsed = JSON.parse(data);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].threadId).toBe("thread-2");

      // Cleanup
      await fs.rm(tmpDir, { recursive: true });
    });

    it("should not save when persistPath is not set", async () => {
      const mgr = new ThreadBindingManager();
      mgr.bind("thread-1", { parentChannelId: "channel-1", agentId: "agent-1" });

      // No error, no file created
      expect(mgr.size).toBe(1);
    });

    it("should clear stale bindings on load when clearStale is true", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "thread-bindings-"));
      const persistPath = path.join(tmpDir, "bindings.json");

      // Pre-create file with stale bindings
      await fs.writeFile(
        persistPath,
        JSON.stringify([
          {
            threadId: "thread-1",
            parentChannelId: "channel-1",
            sessionId: "dead-session-1",
            agentId: "agent-1",
            createdAt: new Date().toISOString(),
          },
          {
            threadId: "thread-2",
            parentChannelId: "channel-2",
            sessionId: "dead-session-2",
            agentId: "agent-2",
            createdAt: new Date().toISOString(),
          },
        ]),
      );

      const mgr = new ThreadBindingManager({ persistPath });
      await mgr.load({ clearStale: true });

      // Bindings should be cleared
      expect(mgr.size).toBe(0);

      // File should be empty too
      const data = await fs.readFile(persistPath, "utf-8");
      const parsed = JSON.parse(data);
      expect(parsed).toEqual([]);

      await fs.rm(tmpDir, { recursive: true });
    });

    it("should keep bindings on load when clearStale is false", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "thread-bindings-"));
      const persistPath = path.join(tmpDir, "bindings.json");

      // Pre-create file with bindings
      await fs.writeFile(
        persistPath,
        JSON.stringify([
          {
            threadId: "thread-1",
            parentChannelId: "channel-1",
            agentId: "agent-1",
            createdAt: new Date().toISOString(),
          },
        ]),
      );

      const mgr = new ThreadBindingManager({ persistPath });
      await mgr.load({ clearStale: false });

      // Bindings should be kept
      expect(mgr.size).toBe(1);
      expect(mgr.get("thread-1")).toBeDefined();

      await fs.rm(tmpDir, { recursive: true });
    });
  });
});
