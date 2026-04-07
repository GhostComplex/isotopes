// src/core/session-store.test.ts — Unit tests for DefaultSessionStore

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

});
