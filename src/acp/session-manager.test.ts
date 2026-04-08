// src/acp/session-manager.test.ts — Unit tests for AcpSessionManager

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AcpSessionManager } from "./session-manager.js";
import type { AcpConfig, AcpSession, AcpSessionEvent } from "./types.js";
import { ThreadBindingManager } from "../core/thread-bindings.js";

function makeConfig(overrides?: Partial<AcpConfig>): AcpConfig {
  return {
    enabled: true,
    backend: "acpx",
    defaultAgent: "claude",
    allowedAgents: ["claude", "codex"],
    ...overrides,
  };
}

describe("AcpSessionManager", () => {
  let manager: AcpSessionManager;

  beforeEach(() => {
    manager = new AcpSessionManager(makeConfig());
  });

  // ---------------------------------------------------------------------------
  // getConfig
  // ---------------------------------------------------------------------------

  describe("getConfig", () => {
    it("returns the config the manager was created with", () => {
      const config = makeConfig({ backend: "codex" });
      const mgr = new AcpSessionManager(config);
      expect(mgr.getConfig()).toBe(config);
    });
  });

  // ---------------------------------------------------------------------------
  // createSession
  // ---------------------------------------------------------------------------

  describe("createSession", () => {
    it("creates a session with the given agentId", () => {
      const session = manager.createSession("claude");

      expect(session.id).toBeDefined();
      expect(session.agentId).toBe("claude");
      expect(session.status).toBe("active");
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(session.lastActivityAt).toBeInstanceOf(Date);
      expect(session.history).toEqual([]);
    });

    it("creates a session with an optional threadId", () => {
      const session = manager.createSession("claude", "thread-123");

      expect(session.threadId).toBe("thread-123");
    });

    it("assigns a unique id to each session", () => {
      const s1 = manager.createSession("claude");
      const s2 = manager.createSession("claude");

      expect(s1.id).not.toBe(s2.id);
    });

    it("rejects agents not in allowedAgents list", () => {
      expect(() => manager.createSession("unknown-agent")).toThrow(
        /not in the allowedAgents list/,
      );
    });

    it("allows any agent when allowedAgents is not set", () => {
      const mgr = new AcpSessionManager(makeConfig({ allowedAgents: undefined }));
      const session = mgr.createSession("any-agent");
      expect(session.agentId).toBe("any-agent");
    });

    it("allows any agent when allowedAgents is empty", () => {
      const mgr = new AcpSessionManager(makeConfig({ allowedAgents: [] }));
      const session = mgr.createSession("any-agent");
      expect(session.agentId).toBe("any-agent");
    });
  });

  // ---------------------------------------------------------------------------
  // getSession
  // ---------------------------------------------------------------------------

  describe("getSession", () => {
    it("retrieves a session by id", () => {
      const created = manager.createSession("claude");
      const retrieved = manager.getSession(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.agentId).toBe("claude");
    });

    it("returns undefined for unknown id", () => {
      expect(manager.getSession("nonexistent")).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // getSessionByThread
  // ---------------------------------------------------------------------------

  describe("getSessionByThread", () => {
    it("finds a session by its threadId", () => {
      manager.createSession("claude", "thread-abc");

      const found = manager.getSessionByThread("thread-abc");
      expect(found).toBeDefined();
      expect(found!.threadId).toBe("thread-abc");
    });

    it("returns undefined when no session matches", () => {
      manager.createSession("claude");
      expect(manager.getSessionByThread("thread-nope")).toBeUndefined();
    });

    it("returns the correct session among multiple", () => {
      manager.createSession("claude", "thread-1");
      const s2 = manager.createSession("codex", "thread-2");

      const found = manager.getSessionByThread("thread-2");
      expect(found!.id).toBe(s2.id);
      expect(found!.agentId).toBe("codex");
    });
  });

  // ---------------------------------------------------------------------------
  // updateSession
  // ---------------------------------------------------------------------------

  describe("updateSession", () => {
    it("updates session status", () => {
      const session = manager.createSession("claude");
      const updated = manager.updateSession(session.id, { status: "idle" });

      expect(updated).toBeDefined();
      expect(updated!.status).toBe("idle");
    });

    it("updates session threadId", () => {
      const session = manager.createSession("claude");
      const updated = manager.updateSession(session.id, { threadId: "thread-new" });

      expect(updated!.threadId).toBe("thread-new");
    });

    it("bumps lastActivityAt", () => {
      const session = manager.createSession("claude");
      const before = session.lastActivityAt;

      // Small delay to ensure timestamp differs
      const updated = manager.updateSession(session.id, { status: "idle" });

      expect(updated!.lastActivityAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it("returns undefined for unknown sessionId", () => {
      expect(manager.updateSession("nonexistent", { status: "idle" })).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // terminateSession
  // ---------------------------------------------------------------------------

  describe("terminateSession", () => {
    it("terminates an existing session", () => {
      const session = manager.createSession("claude");
      const result = manager.terminateSession(session.id);

      expect(result).toBe(true);
      expect(manager.getSession(session.id)!.status).toBe("terminated");
    });

    it("returns false for unknown sessionId", () => {
      expect(manager.terminateSession("nonexistent")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // listSessions
  // ---------------------------------------------------------------------------

  describe("listSessions", () => {
    it("returns all sessions when no filter is given", () => {
      manager.createSession("claude");
      manager.createSession("codex");

      const all = manager.listSessions();
      expect(all).toHaveLength(2);
    });

    it("filters by agentId", () => {
      manager.createSession("claude");
      manager.createSession("codex");
      manager.createSession("claude");

      const filtered = manager.listSessions({ agentId: "claude" });
      expect(filtered).toHaveLength(2);
      expect(filtered.every((s) => s.agentId === "claude")).toBe(true);
    });

    it("filters by status", () => {
      const s1 = manager.createSession("claude");
      manager.createSession("codex");
      manager.terminateSession(s1.id);

      const terminated = manager.listSessions({ status: "terminated" });
      expect(terminated).toHaveLength(1);
      expect(terminated[0].id).toBe(s1.id);
    });

    it("filters by both agentId and status", () => {
      const s1 = manager.createSession("claude");
      manager.createSession("claude");
      manager.createSession("codex");
      manager.terminateSession(s1.id);

      const filtered = manager.listSessions({ agentId: "claude", status: "active" });
      expect(filtered).toHaveLength(1);
    });

    it("returns empty array when no sessions match", () => {
      manager.createSession("claude");
      expect(manager.listSessions({ agentId: "nonexistent" })).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // addMessage
  // ---------------------------------------------------------------------------

  describe("addMessage", () => {
    it("adds a message to a session's history", () => {
      const session = manager.createSession("claude");

      const result = manager.addMessage(session.id, {
        role: "user",
        content: "Hello",
      });

      expect(result).toBe(true);
      expect(manager.getSession(session.id)!.history).toHaveLength(1);
      expect(manager.getSession(session.id)!.history[0].role).toBe("user");
      expect(manager.getSession(session.id)!.history[0].content).toBe("Hello");
      expect(manager.getSession(session.id)!.history[0].timestamp).toBeInstanceOf(Date);
    });

    it("preserves message ordering", () => {
      const session = manager.createSession("claude");

      manager.addMessage(session.id, { role: "user", content: "Hello" });
      manager.addMessage(session.id, { role: "assistant", content: "Hi there!" });
      manager.addMessage(session.id, { role: "user", content: "How are you?" });

      const history = manager.getSession(session.id)!.history;
      expect(history).toHaveLength(3);
      expect(history[0].content).toBe("Hello");
      expect(history[1].content).toBe("Hi there!");
      expect(history[2].content).toBe("How are you?");
    });

    it("returns false for unknown sessionId", () => {
      expect(
        manager.addMessage("nonexistent", { role: "user", content: "Hello" }),
      ).toBe(false);
    });

    it("updates lastActivityAt when adding messages", () => {
      const session = manager.createSession("claude");
      const before = session.lastActivityAt;

      manager.addMessage(session.id, { role: "user", content: "Hello" });

      expect(
        manager.getSession(session.id)!.lastActivityAt.getTime(),
      ).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  // ---------------------------------------------------------------------------
  // onSessionEvent
  // ---------------------------------------------------------------------------

  describe("onSessionEvent", () => {
    it("fires 'created' when a session is created", () => {
      const listener = vi.fn();
      manager.onSessionEvent(listener);

      const session = manager.createSession("claude");

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(session, "created");
    });

    it("fires 'updated' when a session is updated", () => {
      const listener = vi.fn();
      const session = manager.createSession("claude");

      manager.onSessionEvent(listener);
      manager.updateSession(session.id, { status: "idle" });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ status: "idle" }),
        "updated",
      );
    });

    it("fires 'updated' when a message is added", () => {
      const listener = vi.fn();
      const session = manager.createSession("claude");

      manager.onSessionEvent(listener);
      manager.addMessage(session.id, { role: "user", content: "Hello" });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ id: session.id }),
        "updated",
      );
    });

    it("fires 'terminated' when a session is terminated", () => {
      const listener = vi.fn();
      const session = manager.createSession("claude");

      manager.onSessionEvent(listener);
      manager.terminateSession(session.id);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ status: "terminated" }),
        "terminated",
      );
    });

    it("returns an unsubscribe function", () => {
      const listener = vi.fn();
      const unsubscribe = manager.onSessionEvent(listener);

      manager.createSession("claude");
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();

      manager.createSession("codex");
      expect(listener).toHaveBeenCalledTimes(1); // not called again
    });

    it("notifies multiple listeners", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      manager.onSessionEvent(listener1);
      manager.onSessionEvent(listener2);

      manager.createSession("claude");

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it("tracks event types correctly through full lifecycle", () => {
      const events: Array<{ event: AcpSessionEvent; status: string }> = [];
      manager.onSessionEvent((session: AcpSession, event: AcpSessionEvent) => {
        events.push({ event, status: session.status });
      });

      const session = manager.createSession("claude");
      manager.updateSession(session.id, { status: "idle" });
      manager.addMessage(session.id, { role: "user", content: "Hello" });
      manager.terminateSession(session.id);

      expect(events).toEqual([
        { event: "created", status: "active" },
        { event: "updated", status: "idle" },
        { event: "updated", status: "idle" },
        { event: "terminated", status: "terminated" },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // ThreadBindingManager integration
  // ---------------------------------------------------------------------------

  describe("ThreadBindingManager integration", () => {
    it("auto-spawns ACP session when thread is bound with spawnAcpSessions=true", () => {
      const threadManager = new ThreadBindingManager();
      threadManager.attachAcpSessionManager(manager, { spawnAcpSessions: true });

      const binding = threadManager.bind("thread-1", {
        parentChannelId: "channel-1",
        agentId: "claude",
      });

      // Binding should have a sessionId
      expect(binding.sessionId).toBeDefined();

      // ACP session should exist with matching threadId
      const acpSession = manager.getSessionByThread("thread-1");
      expect(acpSession).toBeDefined();
      expect(acpSession!.agentId).toBe("claude");
      expect(acpSession!.id).toBe(binding.sessionId);
    });

    it("does NOT auto-spawn when spawnAcpSessions is false", () => {
      const threadManager = new ThreadBindingManager();
      threadManager.attachAcpSessionManager(manager, { spawnAcpSessions: false });

      const binding = threadManager.bind("thread-1", {
        parentChannelId: "channel-1",
        agentId: "claude",
      });

      expect(binding.sessionId).toBeUndefined();
      expect(manager.getSessionByThread("thread-1")).toBeUndefined();
    });

    it("does NOT auto-spawn when no AcpSessionManager is attached", () => {
      const threadManager = new ThreadBindingManager();

      const binding = threadManager.bind("thread-1", {
        parentChannelId: "channel-1",
        agentId: "claude",
      });

      expect(binding.sessionId).toBeUndefined();
    });

    it("preserves existing sessionId if already set", () => {
      const threadManager = new ThreadBindingManager();
      threadManager.attachAcpSessionManager(manager, { spawnAcpSessions: true });

      const binding = threadManager.bind("thread-1", {
        parentChannelId: "channel-1",
        agentId: "claude",
        sessionId: "pre-existing-session",
      });

      // Should keep the pre-existing sessionId, not create a new one
      expect(binding.sessionId).toBe("pre-existing-session");
    });

    it("detachAcpSessionManager stops auto-spawn", () => {
      const threadManager = new ThreadBindingManager();
      threadManager.attachAcpSessionManager(manager, { spawnAcpSessions: true });

      // First bind should auto-spawn
      const binding1 = threadManager.bind("thread-1", {
        parentChannelId: "channel-1",
        agentId: "claude",
      });
      expect(binding1.sessionId).toBeDefined();

      // Detach
      threadManager.detachAcpSessionManager();

      // Second bind should NOT auto-spawn
      const binding2 = threadManager.bind("thread-2", {
        parentChannelId: "channel-1",
        agentId: "claude",
      });
      expect(binding2.sessionId).toBeUndefined();
    });
  });
});
