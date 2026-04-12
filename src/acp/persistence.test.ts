// src/acp/persistence.test.ts — Unit tests for ACP session persistence (#195)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AcpSessionPersistence } from "./persistence.js";
import { AcpSessionManager } from "./session-manager.js";
import type {
  AcpConfig,
  AcpPersistenceConfig,
  AcpSession,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "acp-persist-test-"));
}

function makePersistenceConfig(overrides?: Partial<AcpPersistenceConfig>): AcpPersistenceConfig {
  return {
    enabled: true,
    dataDir: tmpDir,
    ttl: 86_400,
    cleanupInterval: 3_600,
    ...overrides,
  };
}

function makeAcpConfig(overrides?: Partial<AcpConfig>): AcpConfig {
  return {
    enabled: true,
    backend: "acpx",
    defaultAgent: "claude",
    allowedAgents: ["claude", "codex"],
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await makeTmpDir();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AcpSessionPersistence (low-level)
// ---------------------------------------------------------------------------

describe("AcpSessionPersistence", () => {
  let persistence: AcpSessionPersistence;

  beforeEach(async () => {
    persistence = new AcpSessionPersistence(makePersistenceConfig());
    await persistence.init();
  });

  afterEach(() => {
    persistence.destroy();
  });

  describe("persistIndex + loadAll", () => {
    it("persists sessions to disk and restores them", async () => {
      const sessions = new Map<string, AcpSession>();
      const threadIndex = new Map<string, string>();

      const now = new Date();
      const session: AcpSession = {
        id: "session-1",
        agentId: "claude",
        threadId: "thread-1",
        status: "active",
        createdAt: now,
        lastActivityAt: now,
        history: [],
      };
      sessions.set(session.id, session);
      threadIndex.set("thread-1", "session-1");

      await persistence.persistIndex(sessions, threadIndex);

      // Verify file exists
      const indexPath = path.join(tmpDir, "acp-sessions.json");
      const stat = await fs.stat(indexPath);
      expect(stat.isFile()).toBe(true);

      // Load and verify
      const loaded = await persistence.loadAll();
      expect(loaded.sessions.size).toBe(1);
      expect(loaded.threadIndex.size).toBe(1);

      const restored = loaded.sessions.get("session-1")!;
      expect(restored.agentId).toBe("claude");
      expect(restored.threadId).toBe("thread-1");
      expect(restored.status).toBe("active");
      expect(restored.createdAt).toBeInstanceOf(Date);
      expect(restored.lastActivityAt).toBeInstanceOf(Date);
      expect(restored.history).toEqual([]);

      expect(loaded.threadIndex.get("thread-1")).toBe("session-1");
    });

    it("returns empty maps when no index file exists", async () => {
      const loaded = await persistence.loadAll();
      expect(loaded.sessions.size).toBe(0);
      expect(loaded.threadIndex.size).toBe(0);
    });

    it("handles corrupted index file gracefully", async () => {
      const indexPath = path.join(tmpDir, "acp-sessions.json");
      await fs.writeFile(indexPath, "NOT VALID JSON{{{");

      const loaded = await persistence.loadAll();
      expect(loaded.sessions.size).toBe(0);
      expect(loaded.threadIndex.size).toBe(0);
    });

    it("skips thread index entries for non-existent sessions", async () => {
      const indexPath = path.join(tmpDir, "acp-sessions.json");
      await fs.writeFile(indexPath, JSON.stringify({
        sessions: {},
        threadIndex: { "thread-orphan": "nonexistent-session" },
      }));

      const loaded = await persistence.loadAll();
      expect(loaded.threadIndex.size).toBe(0);
    });
  });

  describe("appendMessage + loadMessages", () => {
    it("persists messages to JSONL and loads them back", async () => {
      const ts = new Date("2025-01-15T10:00:00Z");
      await persistence.appendMessage("session-1", {
        role: "user",
        content: "Hello",
        timestamp: ts,
      });
      await persistence.appendMessage("session-1", {
        role: "assistant",
        content: "Hi there!",
        timestamp: new Date("2025-01-15T10:00:01Z"),
      });

      const messages = await persistence.loadMessages("session-1");
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("Hello");
      expect(messages[0].timestamp).toBeInstanceOf(Date);
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].content).toBe("Hi there!");
    });

    it("returns empty array for non-existent session", async () => {
      const messages = await persistence.loadMessages("nonexistent");
      expect(messages).toEqual([]);
    });

    it("skips malformed lines in transcript", async () => {
      const file = path.join(tmpDir, "session-bad.jsonl");
      const goodLine = JSON.stringify({
        type: "message",
        role: "user",
        content: "Good",
        timestamp: new Date().toISOString(),
      });
      await fs.writeFile(file, `${goodLine}\nNOT JSON\n${goodLine}\n`);

      const messages = await persistence.loadMessages("session-bad");
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe("Good");
    });
  });

  describe("findStaleSessions", () => {
    it("marks sessions older than TTL as stale", () => {
      const sessions = new Map<string, AcpSession>();
      const oldDate = new Date(Date.now() - 100_000 * 1_000); // 100k seconds ago

      sessions.set("old-session", {
        id: "old-session",
        agentId: "claude",
        status: "active",
        createdAt: oldDate,
        lastActivityAt: oldDate,
        history: [],
      });
      sessions.set("fresh-session", {
        id: "fresh-session",
        agentId: "claude",
        status: "active",
        createdAt: new Date(),
        lastActivityAt: new Date(),
        history: [],
      });

      const stale = persistence.findStaleSessions(sessions);
      expect(stale).toContain("old-session");
      expect(stale).not.toContain("fresh-session");
    });

    it("always considers terminated sessions as stale", () => {
      const sessions = new Map<string, AcpSession>();

      sessions.set("terminated-session", {
        id: "terminated-session",
        agentId: "claude",
        status: "terminated",
        createdAt: new Date(),
        lastActivityAt: new Date(),
        history: [],
      });

      const stale = persistence.findStaleSessions(sessions);
      expect(stale).toContain("terminated-session");
    });
  });

  describe("deleteTranscript", () => {
    it("removes transcript file", async () => {
      await persistence.appendMessage("session-del", {
        role: "user",
        content: "Delete me",
        timestamp: new Date(),
      });

      const file = path.join(tmpDir, "session-del.jsonl");
      await expect(fs.stat(file)).resolves.toBeDefined();

      await persistence.deleteTranscript("session-del");
      await expect(fs.stat(file)).rejects.toThrow();
    });

    it("does not throw for non-existent transcript", async () => {
      await expect(
        persistence.deleteTranscript("nonexistent"),
      ).resolves.not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// AcpSessionManager with persistence (integration)
// ---------------------------------------------------------------------------

describe.skip("AcpSessionManager with persistence", () => {
  let manager: AcpSessionManager;

  afterEach(() => {
    manager?.destroy();
  });

  it("persists sessions to disk on creation", async () => {
    manager = new AcpSessionManager(makeAcpConfig());
    await manager.init(makePersistenceConfig());

    manager.createSession("claude", "thread-1");
    manager.createSession("codex");

    // Allow debounced writes to flush
    await new Promise((r) => setTimeout(r, 50));

    // Verify index file was written
    const indexPath = path.join(tmpDir, "acp-sessions.json");
    const raw = await fs.readFile(indexPath, "utf-8");
    const index = JSON.parse(raw);
    expect(Object.keys(index.sessions)).toHaveLength(2);
    expect(index.threadIndex["thread-1"]).toBeDefined();
  });

  it("restores sessions on init from persisted data", async () => {
    // Create and persist sessions
    const manager1 = new AcpSessionManager(makeAcpConfig());
    await manager1.init(makePersistenceConfig());

    const s1 = manager1.createSession("claude", "thread-abc");
    manager1.addMessage(s1.id, { role: "user", content: "Hello" });
    manager1.addMessage(s1.id, { role: "assistant", content: "Hi!" });

    // Allow writes to flush
    await new Promise((r) => setTimeout(r, 100));
    manager1.destroy();

    // Create a new manager and init — should restore
    manager = new AcpSessionManager(makeAcpConfig());
    await manager.init(makePersistenceConfig());

    const restored = manager.getSession(s1.id);
    expect(restored).toBeDefined();
    expect(restored!.agentId).toBe("claude");
    expect(restored!.threadId).toBe("thread-abc");
    expect(restored!.status).toBe("active");
    expect(restored!.history).toHaveLength(2);
    expect(restored!.history[0].content).toBe("Hello");
    expect(restored!.history[1].content).toBe("Hi!");

    // Thread index should be restored
    const byThread = manager.getSessionByThread("thread-abc");
    expect(byThread).toBeDefined();
    expect(byThread!.id).toBe(s1.id);
  });

  it("persists session updates (status, threadId)", async () => {
    manager = new AcpSessionManager(makeAcpConfig());
    await manager.init(makePersistenceConfig());

    const s = manager.createSession("claude");
    manager.updateSession(s.id, { status: "paused", threadId: "thread-new" });

    // Allow writes to flush
    await new Promise((r) => setTimeout(r, 50));

    // Re-load
    const manager2 = new AcpSessionManager(makeAcpConfig());
    await manager2.init(makePersistenceConfig());

    const restored = manager2.getSession(s.id);
    expect(restored!.status).toBe("paused");
    expect(restored!.threadId).toBe("thread-new");
    manager2.destroy();
  });

  it("persists termination", async () => {
    manager = new AcpSessionManager(makeAcpConfig());
    await manager.init(makePersistenceConfig());

    const s = manager.createSession("claude");
    manager.terminateSession(s.id);

    // Allow writes to flush
    await new Promise((r) => setTimeout(r, 50));

    const manager2 = new AcpSessionManager(makeAcpConfig());
    await manager2.init(makePersistenceConfig());

    const restored = manager2.getSession(s.id);
    expect(restored!.status).toBe("terminated");
    manager2.destroy();
  });

  it("cleans up stale sessions based on TTL", async () => {
    manager = new AcpSessionManager(makeAcpConfig());
    // Very short TTL for testing
    await manager.init(makePersistenceConfig({ ttl: 0.001 }));

    const s = manager.createSession("claude");
    manager.addMessage(s.id, { role: "user", content: "Hello" });

    // Wait for session to become stale
    await new Promise((r) => setTimeout(r, 50));

    const cleaned = await manager.cleanupStaleSessions();
    expect(cleaned).toContain(s.id);
    expect(manager.getSession(s.id)).toBeUndefined();
  });

  it("works without persistence (backwards compatible)", async () => {
    manager = new AcpSessionManager(makeAcpConfig());
    // Do NOT call init — no persistence

    const s = manager.createSession("claude");
    manager.addMessage(s.id, { role: "user", content: "Hello" });

    expect(manager.getSession(s.id)!.history).toHaveLength(1);
    expect(manager.listSessions()).toHaveLength(1);
  });

  it("purgeTerminated removes persisted transcripts", async () => {
    manager = new AcpSessionManager(makeAcpConfig());
    await manager.init(makePersistenceConfig());

    const s = manager.createSession("claude");
    manager.addMessage(s.id, { role: "user", content: "Hello" });
    manager.terminateSession(s.id);

    // Allow writes to flush
    await new Promise((r) => setTimeout(r, 50));

    const purged = manager.purgeTerminated();
    expect(purged).toBe(1);
    expect(manager.getSession(s.id)).toBeUndefined();

    // Allow delete to complete
    await new Promise((r) => setTimeout(r, 50));

    // Transcript file should be gone
    const transcriptPath = path.join(tmpDir, `${s.id}.jsonl`);
    await expect(fs.stat(transcriptPath)).rejects.toThrow();
  });

  it("handles multiple sessions with different agents", async () => {
    manager = new AcpSessionManager(makeAcpConfig());
    await manager.init(makePersistenceConfig());

    const s1 = manager.createSession("claude", "t1");
    const s2 = manager.createSession("codex", "t2");
    manager.addMessage(s1.id, { role: "user", content: "Msg to claude" });
    manager.addMessage(s2.id, { role: "user", content: "Msg to codex" });

    await new Promise((r) => setTimeout(r, 100));
    manager.destroy();

    const manager2 = new AcpSessionManager(makeAcpConfig());
    await manager2.init(makePersistenceConfig());

    expect(manager2.listSessions()).toHaveLength(2);
    expect(manager2.getSessionByThread("t1")!.agentId).toBe("claude");
    expect(manager2.getSessionByThread("t2")!.agentId).toBe("codex");
    expect(manager2.getSession(s1.id)!.history[0].content).toBe("Msg to claude");
    expect(manager2.getSession(s2.id)!.history[0].content).toBe("Msg to codex");
    manager2.destroy();
  });
});
