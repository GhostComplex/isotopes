// src/core/thread-bindings.test.ts — Unit tests for ThreadBindingManager

import { describe, it, expect, vi, beforeEach } from "vitest";
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
  // unbindBySessionId
  // ---------------------------------------------------------------------------

  describe("unbindBySessionId", () => {
    it("removes binding by sessionId and returns true", () => {
      manager.bind("thread-1", {
        parentChannelId: "channel-1",
        sessionId: "session-abc",
        agentId: "agent-1",
      });

      const removed = manager.unbindBySessionId("session-abc");
      expect(removed).toBe(true);
      expect(manager.get("thread-1")).toBeUndefined();
      expect(manager.size).toBe(0);
    });

    it("returns false when sessionId does not exist", () => {
      manager.bind("thread-1", {
        parentChannelId: "channel-1",
        agentId: "agent-1",
      });

      const removed = manager.unbindBySessionId("nonexistent");
      expect(removed).toBe(false);
      expect(manager.size).toBe(1);
    });

    it("passes reason to unbind listeners", () => {
      const listener = vi.fn();
      manager.onUnbind(listener);

      manager.bind("thread-1", {
        parentChannelId: "channel-1",
        sessionId: "session-abc",
        agentId: "agent-1",
      });

      manager.unbindBySessionId("session-abc", "task-completed");

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][1]).toBe("task-completed");
    });
  });

  // ---------------------------------------------------------------------------
  // getBySessionId
  // ---------------------------------------------------------------------------

  describe("getBySessionId", () => {
    it("finds a binding by sessionId", () => {
      manager.bind("thread-1", {
        parentChannelId: "channel-1",
        sessionId: "session-abc",
        agentId: "agent-1",
      });

      const result = manager.getBySessionId("session-abc");
      expect(result).toBeDefined();
      expect(result!.threadId).toBe("thread-1");
    });

    it("returns undefined when sessionId is not found", () => {
      manager.bind("thread-1", {
        parentChannelId: "channel-1",
        agentId: "agent-1",
      });

      expect(manager.getBySessionId("nonexistent")).toBeUndefined();
    });

    it("returns undefined when no bindings have sessionId set", () => {
      manager.bind("thread-1", {
        parentChannelId: "channel-1",
        agentId: "agent-1",
      });

      expect(manager.getBySessionId("anything")).toBeUndefined();
    });

    it("returns the correct binding among multiple", () => {
      manager.bind("thread-1", {
        parentChannelId: "channel-1",
        sessionId: "session-1",
        agentId: "agent-1",
      });
      manager.bind("thread-2", {
        parentChannelId: "channel-1",
        sessionId: "session-2",
        agentId: "agent-2",
      });

      const result = manager.getBySessionId("session-2");
      expect(result!.threadId).toBe("thread-2");
      expect(result!.agentId).toBe("agent-2");
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
});
