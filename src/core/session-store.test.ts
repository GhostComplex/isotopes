// src/core/session-store.test.ts — Unit tests for DefaultSessionStore

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DefaultSessionStore } from "./session-store.js";
import type { Message } from "./types.js";
import { textContent } from "./types.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe("DefaultSessionStore", () => {
  let tempDir: string;
  let store: DefaultSessionStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-test-"));
    store = new DefaultSessionStore({ dataDir: tempDir });
    await store.init();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates a session with unique id", async () => {
      const session = await store.create("agent-1");

      expect(session.id).toBeDefined();
      expect(session.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(session.agentId).toBe("agent-1");
    });

    it("stores metadata", async () => {
      const session = await store.create("agent-1", {
        transport: "discord",
        channelId: "123456",
      });

      expect(session.metadata?.transport).toBe("discord");
      expect(session.metadata?.channelId).toBe("123456");
    });

    it("stores session key in metadata", async () => {
      const session = await store.create("agent-1", {
        key: "discord:bot1:channel:123:agent-1",
        transport: "discord",
        channelId: "123",
      });

      expect(session.metadata?.key).toBe("discord:bot1:channel:123:agent-1");
    });

    it("throws if key already exists", async () => {
      await store.create("agent-1", {
        key: "duplicate-key",
        transport: "discord",
      });

      await expect(
        store.create("agent-2", {
          key: "duplicate-key",
          transport: "discord",
        })
      ).rejects.toThrow("Session with key already exists: duplicate-key");
    });

    it("persists session to disk", async () => {
      const session = await store.create("agent-1");

      const indexFile = path.join(tempDir, "sessions.json");
      const content = await fs.readFile(indexFile, "utf-8");
      const index = JSON.parse(content);
      const meta = index.sessions[session.id];

      expect(meta.id).toBe(session.id);
      expect(meta.agentId).toBe("agent-1");
    });
  });

  describe("get", () => {
    it("returns session by id", async () => {
      const created = await store.create("agent-1");
      const retrieved = await store.get(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.agentId).toBe("agent-1");
    });

    it("returns undefined for non-existent session", async () => {
      const result = await store.get("non-existent");
      expect(result).toBeUndefined();
    });

    it("loads session from disk if not in memory", async () => {
      const created = await store.create("agent-1");

      // Create a new store instance (simulates restart)
      const newStore = new DefaultSessionStore({ dataDir: tempDir });
      await newStore.init();

      const loaded = await newStore.get(created.id);
      expect(loaded).toBeDefined();
      expect(loaded?.id).toBe(created.id);
    });
  });

  describe("findByKey", () => {
    it("finds session by key", async () => {
      const session = await store.create("agent-1", {
        key: "discord:bot1:channel:123:agent-1",
        transport: "discord",
      });

      const found = await store.findByKey("discord:bot1:channel:123:agent-1");
      expect(found).toBeDefined();
      expect(found?.id).toBe(session.id);
    });

    it("returns undefined for non-existent key", async () => {
      const result = await store.findByKey("non-existent-key");
      expect(result).toBeUndefined();
    });

    it("restores key index after restart", async () => {
      const session = await store.create("agent-1", {
        key: "discord:bot1:channel:456:agent-1",
        transport: "discord",
      });

      // Create a new store instance (simulates restart)
      const newStore = new DefaultSessionStore({ dataDir: tempDir });
      await newStore.init();

      const found = await newStore.findByKey("discord:bot1:channel:456:agent-1");
      expect(found).toBeDefined();
      expect(found?.id).toBe(session.id);
    });
  });

  describe("addMessage / getMessages", () => {
    it("stores and retrieves messages", async () => {
      const session = await store.create("agent-1");

      const msg1: Message = { role: "user", content: textContent("Hello") };
      const msg2: Message = { role: "assistant", content: textContent("Hi there!") };

      await store.addMessage(session.id, msg1);
      await store.addMessage(session.id, msg2);

      const messages = await store.getMessages(session.id);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toEqual(textContent("Hello"));
      expect(messages[1].content).toEqual(textContent("Hi there!"));
    });

    it("persists messages to JSONL file", async () => {
      const session = await store.create("agent-1");

      await store.addMessage(session.id, { role: "user", content: textContent("Test") });

      const messagesFile = path.join(tempDir, `${session.id}.jsonl`);
      const content = await fs.readFile(messagesFile, "utf-8");
      const lines = content.trim().split("\n");
      const record = JSON.parse(lines[0]);

      expect(lines).toHaveLength(1);
      expect(record.type).toBe("message");
      expect(record.message.content).toEqual(textContent("Test"));
    });

    it("loads messages from disk", async () => {
      const session = await store.create("agent-1");
      await store.addMessage(session.id, { role: "user", content: textContent("Persisted") });

      // New store instance
      const newStore = new DefaultSessionStore({ dataDir: tempDir });
      await newStore.init();

      const messages = await newStore.getMessages(session.id);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toEqual(textContent("Persisted"));
    });

    it("throws if session not found", async () => {
      await expect(
        store.addMessage("non-existent", { role: "user", content: textContent("Hi") }),
      ).rejects.toThrow('Session "non-existent" not found');

      await expect(store.getMessages("non-existent")).rejects.toThrow(
        'Session "non-existent" not found',
      );
    });
  });

  describe("delete", () => {
    it("removes session from memory", async () => {
      const session = await store.create("agent-1");
      await store.delete(session.id);

      const result = await store.get(session.id);
      expect(result).toBeUndefined();
    });

    it("removes session from key index", async () => {
      const session = await store.create("agent-1", {
        key: "test-key",
        transport: "discord",
      });

      await store.delete(session.id);

      const found = await store.findByKey("test-key");
      expect(found).toBeUndefined();
    });

    it("removes session files from disk", async () => {
      const session = await store.create("agent-1");
      await store.addMessage(session.id, { role: "user", content: textContent("persist me") });
      const transcriptFile = path.join(tempDir, `${session.id}.jsonl`);

      await store.delete(session.id);

      await expect(fs.access(transcriptFile)).rejects.toThrow();
    });

    it("updates the persisted index after deleting a session", async () => {
      const session = await store.create("agent-1", {
        key: "delete-key",
        transport: "discord",
      });

      await store.delete(session.id);

      const indexFile = path.join(tempDir, "sessions.json");
      const content = await fs.readFile(indexFile, "utf-8");
      const index = JSON.parse(content);

      expect(index.sessions[session.id]).toBeUndefined();
      expect(index.keyIndex["delete-key"]).toBeUndefined();
    });

    it("does not throw for non-existent session", async () => {
      await expect(store.delete("non-existent")).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // TTL & cleanup
  // -------------------------------------------------------------------------

  describe("getSessionAge", () => {
    it("returns age in seconds for an existing session", async () => {
      const session = await store.create("agent-1");

      // Freshly created session should be ~0 seconds old
      const age = store.getSessionAge(session.id);
      expect(age).toBeDefined();
      expect(age!).toBeLessThan(2);
    });

    it("returns undefined for a non-existent session", () => {
      const age = store.getSessionAge("non-existent");
      expect(age).toBeUndefined();
    });
  });

  describe("cleanupExpiredSessions", () => {
    it("deletes sessions older than TTL", async () => {
      // Create a store with a very short TTL (1 second)
      const shortTtlStore = new DefaultSessionStore({
        dataDir: tempDir,
        session: { ttl: 1 },
      });
      await shortTtlStore.init();

      const session = await shortTtlStore.create("agent-1");

      // Manually backdate the session's lastActiveAt by 2 seconds
      // We access the private map through a cast to do this in testing
      const sessions = (shortTtlStore as unknown as { sessions: Map<string, { lastActiveAt: Date }> }).sessions;
      const stored = sessions.get(session.id)!;
      stored.lastActiveAt = new Date(Date.now() - 2_000);

      const deleted = await shortTtlStore.cleanupExpiredSessions();

      expect(deleted).toContain(session.id);
      expect(await shortTtlStore.get(session.id)).toBeUndefined();
    });

    it("keeps sessions that are within TTL", async () => {
      const session = await store.create("agent-1");

      // Default TTL is 24h, session is fresh — should not be cleaned up
      const deleted = await store.cleanupExpiredSessions();

      expect(deleted).not.toContain(session.id);
      expect(await store.get(session.id)).toBeDefined();
    });

    it("removes transcript files for expired sessions", async () => {
      const shortTtlStore = new DefaultSessionStore({
        dataDir: tempDir,
        session: { ttl: 1 },
      });
      await shortTtlStore.init();

      const session = await shortTtlStore.create("agent-1");
      await shortTtlStore.addMessage(session.id, {
        role: "user",
        content: textContent("test message"),
      });

      const transcriptFile = path.join(tempDir, `${session.id}.jsonl`);
      // Verify transcript exists
      await expect(fs.access(transcriptFile)).resolves.not.toThrow();

      // Backdate and cleanup
      const sessions = (shortTtlStore as unknown as { sessions: Map<string, { lastActiveAt: Date }> }).sessions;
      sessions.get(session.id)!.lastActiveAt = new Date(Date.now() - 2_000);

      await shortTtlStore.cleanupExpiredSessions();

      // Transcript file should be gone
      await expect(fs.access(transcriptFile)).rejects.toThrow();
    });

    it("cleans up key index for expired sessions", async () => {
      const shortTtlStore = new DefaultSessionStore({
        dataDir: tempDir,
        session: { ttl: 1 },
      });
      await shortTtlStore.init();

      const session = await shortTtlStore.create("agent-1", {
        key: "cleanup-key",
        transport: "discord",
      });

      // Backdate
      const sessions = (shortTtlStore as unknown as { sessions: Map<string, { lastActiveAt: Date }> }).sessions;
      sessions.get(session.id)!.lastActiveAt = new Date(Date.now() - 2_000);

      await shortTtlStore.cleanupExpiredSessions();

      expect(await shortTtlStore.findByKey("cleanup-key")).toBeUndefined();
    });
  });

  describe("startCleanupTimer / stopCleanupTimer", () => {
    it("runs periodic cleanup", async () => {
      vi.useFakeTimers();

      const shortStore = new DefaultSessionStore({
        dataDir: tempDir,
        session: { ttl: 1, cleanupInterval: 1 },
      });
      await shortStore.init();

      const session = await shortStore.create("agent-1");

      // Backdate the session
      const sessions = (shortStore as unknown as { sessions: Map<string, { lastActiveAt: Date }> }).sessions;
      sessions.get(session.id)!.lastActiveAt = new Date(Date.now() - 2_000);

      shortStore.startCleanupTimer();

      // Advance timer to trigger cleanup
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await shortStore.get(session.id)).toBeUndefined();

      shortStore.destroy();
      vi.useRealTimers();
    });

    it("stopCleanupTimer prevents further cleanup", async () => {
      vi.useFakeTimers();

      const shortStore = new DefaultSessionStore({
        dataDir: tempDir,
        session: { ttl: 1, cleanupInterval: 1 },
      });
      await shortStore.init();

      shortStore.startCleanupTimer();
      shortStore.stopCleanupTimer();

      const session = await shortStore.create("agent-1");

      // Backdate the session
      const sessions = (shortStore as unknown as { sessions: Map<string, { lastActiveAt: Date }> }).sessions;
      sessions.get(session.id)!.lastActiveAt = new Date(Date.now() - 2_000);

      // Advance timer — cleanup should NOT run because we stopped it
      await vi.advanceTimersByTimeAsync(2_000);

      // Session should still exist
      expect(await shortStore.get(session.id)).toBeDefined();

      shortStore.destroy();
      vi.useRealTimers();
    });
  });

  describe("destroy", () => {
    it("stops cleanup timer", () => {
      vi.useFakeTimers();

      const timedStore = new DefaultSessionStore({
        dataDir: tempDir,
        session: { ttl: 1, cleanupInterval: 1 },
      });
      timedStore.startCleanupTimer();
      timedStore.destroy();

      // Should not throw or leak timers
      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // clearMessages
  // -------------------------------------------------------------------------

  describe("clearMessages", () => {
    it("clears in-memory messages", async () => {
      const session = await store.create("agent-1");
      await store.addMessage(session.id, { role: "user", content: textContent("msg1") });
      await store.addMessage(session.id, { role: "assistant", content: textContent("msg2") });

      await store.clearMessages(session.id);

      const messages = await store.getMessages(session.id);
      expect(messages).toHaveLength(0);
    });

    it("truncates transcript file on disk", async () => {
      const session = await store.create("agent-1");
      await store.addMessage(session.id, { role: "user", content: textContent("persist1") });
      await store.addMessage(session.id, { role: "assistant", content: textContent("persist2") });

      const transcriptFile = path.join(tempDir, `${session.id}.jsonl`);

      // Verify messages are persisted
      const beforeContent = await fs.readFile(transcriptFile, "utf-8");
      expect(beforeContent.trim().split("\n")).toHaveLength(2);

      await store.clearMessages(session.id);

      // Verify transcript is truncated
      const afterContent = await fs.readFile(transcriptFile, "utf-8");
      expect(afterContent).toBe("");
    });

    it("throws on non-existent session", async () => {
      await expect(
        store.clearMessages("non-existent"),
      ).rejects.toThrow('Session "non-existent" not found');
    });

    it("updates lastActiveAt", async () => {
      const session = await store.create("agent-1");

      // Wait a tiny bit to ensure time difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      const beforeTimestamp = (await store.get(session.id))!.lastActiveAt.getTime();

      await store.clearMessages(session.id);

      const afterTimestamp = (await store.get(session.id))!.lastActiveAt.getTime();
      expect(afterTimestamp).toBeGreaterThan(beforeTimestamp);
    });
  });

  describe("setMessages", () => {
    it("replaces in-memory messages", async () => {
      const session = await store.create("agent-1");
      await store.addMessage(session.id, { role: "user", content: textContent("old1") });
      await store.addMessage(session.id, { role: "assistant", content: textContent("old2") });

      const newMessages = [
        { role: "user" as const, content: textContent("new1") },
        { role: "assistant" as const, content: textContent("new2") },
        { role: "user" as const, content: textContent("new3") },
      ];

      await store.setMessages(session.id, newMessages);

      const messages = await store.getMessages(session.id);
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toEqual(textContent("new1"));
      expect(messages[1].content).toEqual(textContent("new2"));
      expect(messages[2].content).toEqual(textContent("new3"));
    });

    it("overwrites transcript file on disk", async () => {
      const session = await store.create("agent-1");
      await store.addMessage(session.id, { role: "user", content: textContent("old1") });
      await store.addMessage(session.id, { role: "assistant", content: textContent("old2") });

      const transcriptFile = path.join(tempDir, `${session.id}.jsonl`);

      // Verify old messages are persisted
      const beforeContent = await fs.readFile(transcriptFile, "utf-8");
      expect(beforeContent.trim().split("\n")).toHaveLength(2);

      const newMessages = [
        { role: "user" as const, content: textContent("new1") },
      ];

      await store.setMessages(session.id, newMessages);

      // Verify transcript is overwritten with new messages
      const afterContent = await fs.readFile(transcriptFile, "utf-8");
      const lines = afterContent.trim().split("\n");
      expect(lines).toHaveLength(1);

      const record = JSON.parse(lines[0]);
      expect(record.message.content).toEqual(textContent("new1"));
    });

    it("persists after store restart", async () => {
      const session = await store.create("agent-1");
      await store.addMessage(session.id, { role: "user", content: textContent("old") });

      const newMessages = [
        { role: "user" as const, content: textContent("compacted1") },
        { role: "assistant" as const, content: textContent("compacted2") },
      ];

      await store.setMessages(session.id, newMessages);

      // Create new store instance
      const newStore = new DefaultSessionStore({ dataDir: tempDir });
      await newStore.init();

      const messages = await newStore.getMessages(session.id);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toEqual(textContent("compacted1"));
      expect(messages[1].content).toEqual(textContent("compacted2"));
    });

    it("throws on non-existent session", async () => {
      await expect(
        store.setMessages("non-existent", [{ role: "user", content: textContent("test") }]),
      ).rejects.toThrow('Session "non-existent" not found');
    });

    it("updates lastActiveAt", async () => {
      const session = await store.create("agent-1");

      // Wait a tiny bit to ensure time difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      const beforeTimestamp = (await store.get(session.id))!.lastActiveAt.getTime();

      await store.setMessages(session.id, [{ role: "user", content: textContent("test") }]);

      const afterTimestamp = (await store.get(session.id))!.lastActiveAt.getTime();
      expect(afterTimestamp).toBeGreaterThan(beforeTimestamp);
    });

    it("handles empty message array", async () => {
      const session = await store.create("agent-1");
      await store.addMessage(session.id, { role: "user", content: textContent("old") });

      await store.setMessages(session.id, []);

      const messages = await store.getMessages(session.id);
      expect(messages).toHaveLength(0);
    });
  });

  describe("setMetadata", () => {
    it("merges patch into existing metadata and persists to index", async () => {
      const session = await store.create("dev", {
        subagent: {
          parentAgentId: "dev",
          taskId: "task-1",
          backend: "claude",
        },
      });

      await store.setMetadata(session.id, {
        subagent: {
          parentAgentId: "dev",
          taskId: "task-1",
          backend: "claude",
          exitCode: 0,
          costUsd: 0.42,
          durationMs: 1234,
        },
      });

      const got = await store.get(session.id);
      expect(got?.metadata?.subagent?.exitCode).toBe(0);
      expect(got?.metadata?.subagent?.costUsd).toBe(0.42);

      // Reopen the store to confirm the patch survived persistence.
      const reopened = new DefaultSessionStore({ dataDir: tempDir });
      await reopened.init();
      const reloaded = await reopened.get(session.id);
      expect(reloaded?.metadata?.subagent?.exitCode).toBe(0);
      expect(reloaded?.metadata?.subagent?.durationMs).toBe(1234);
      reopened.destroy();
    });

    it("throws on unknown sessionId", async () => {
      await expect(store.setMetadata("nope", { transport: "discord" })).rejects.toThrow(
        /not found/,
      );
    });
  });

});
