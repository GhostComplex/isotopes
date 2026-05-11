import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DefaultSessionStore, SessionStoreManager } from "./session-store.js";
import { getAgentSessionsDir, normalizeAgentId } from "../../paths.js";

import { userMessage, assistantMessage, messageText } from "./messages.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe("DefaultSessionStore", () => {
  let tempDir: string;
  let store: DefaultSessionStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-test-"));
    store = new DefaultSessionStore(tempDir);
    await store.init();
  });

  afterEach(async () => {
    store.destroy();
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
        channel: "discord",
        channelId: "123456",
      });

      expect(session.metadata?.channel).toBe("discord");
      expect(session.metadata?.channelId).toBe("123456");
    });

    it("stores session key in metadata", async () => {
      const session = await store.create("agent-1", {
        key: "discord:bot1:channel:123:agent-1",
        channel: "discord",
        channelId: "123",
      });

      expect(session.metadata?.key).toBe("discord:bot1:channel:123:agent-1");
    });

    it("throws if key already exists", async () => {
      await store.create("agent-1", {
        key: "duplicate-key",
        channel: "discord",
      });

      await expect(
        store.create("agent-2", {
          key: "duplicate-key",
          channel: "discord",
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
      const newStore = new DefaultSessionStore(tempDir);
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
        channel: "discord",
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
        channel: "discord",
      });

      // Create a new store instance (simulates restart)
      const newStore = new DefaultSessionStore(tempDir);
      await newStore.init();

      const found = await newStore.findByKey("discord:bot1:channel:456:agent-1");
      expect(found).toBeDefined();
      expect(found?.id).toBe(session.id);
    });
  });

  describe("addMessage / getMessages", () => {
    it("stores and retrieves messages", async () => {
      const session = await store.create("agent-1");

      const msg1 = userMessage("Hello");
      const msg2 = assistantMessage("Hi there!");

      await store.addMessage(session.id, msg1);
      await store.addMessage(session.id, msg2);

      const messages = await store.getMessages(session.id);
      expect(messages).toHaveLength(2);
      expect(messageText(messages[0])).toBe("Hello");
      expect(messageText(messages[1])).toBe("Hi there!");
    });

    it("persists messages to JSONL file", async () => {
      const session = await store.create("agent-1");

      await store.addMessage(session.id, userMessage("Test"));
      await store.addMessage(session.id, assistantMessage("Reply"));

      // SessionManager defers file creation until an assistant message exists
      const messagesFile = path.join(tempDir, `${session.id}.jsonl`);
      const content = await fs.readFile(messagesFile, "utf-8");
      expect(content.trim().split("\n").length).toBeGreaterThanOrEqual(3); // header + 2 messages

      const messages = await store.getMessages(session.id);
      expect(messages).toHaveLength(2);
      expect(messageText(messages[0])).toBe("Test");
      expect(messageText(messages[1])).toBe("Reply");
    });

    it("loads messages from disk", async () => {
      const session = await store.create("agent-1");
      await store.addMessage(session.id, userMessage("Persisted"));
      await store.addMessage(session.id, assistantMessage("Response"));

      // New store instance
      const newStore = new DefaultSessionStore(tempDir);
      await newStore.init();

      const messages = await newStore.getMessages(session.id);
      expect(messages).toHaveLength(2);
      expect(messageText(messages[0])).toBe("Persisted");
      expect(messageText(messages[1])).toBe("Response");
    });

    it("throws if session not found", async () => {
      await expect(
        store.addMessage("non-existent", userMessage("Hi")),
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
        channel: "discord",
      });

      await store.delete(session.id);

      const found = await store.findByKey("test-key");
      expect(found).toBeUndefined();
    });

    it("removes session files from disk", async () => {
      const session = await store.create("agent-1");
      await store.addMessage(session.id, userMessage("persist me"));
      const transcriptFile = path.join(tempDir, `${session.id}.jsonl`);

      await store.delete(session.id);

      await expect(fs.access(transcriptFile)).rejects.toThrow();
    });

    it("updates the persisted index after deleting a session", async () => {
      const session = await store.create("agent-1", {
        key: "delete-key",
        channel: "discord",
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
  // clearMessages
  // -------------------------------------------------------------------------

  describe("clearMessages", () => {
    it("clears in-memory messages", async () => {
      const session = await store.create("agent-1");
      await store.addMessage(session.id, userMessage("msg1"));
      await store.addMessage(session.id, assistantMessage("msg2"));

      await store.clearMessages(session.id);

      const messages = await store.getMessages(session.id);
      expect(messages).toHaveLength(0);
    });

    it("truncates transcript file on disk", async () => {
      const session = await store.create("agent-1");
      await store.addMessage(session.id, userMessage("persist1"));
      await store.addMessage(session.id, assistantMessage("persist2"));

      // Verify messages are persisted
      const beforeMessages = await store.getMessages(session.id);
      expect(beforeMessages).toHaveLength(2);

      await store.clearMessages(session.id);

      // Verify messages are cleared
      const afterMessages = await store.getMessages(session.id);
      expect(afterMessages).toHaveLength(0);
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

  describe("transcript bus (subscribe)", () => {
    it("emits a TranscriptUpdate when addMessage appends", async () => {
      const session = await store.create("agent-1");
      const seen: Array<{ messageId: string }> = [];
      const unsubscribe = store.subscribe(session.id, (u) => seen.push({ messageId: u.messageId }));
      try {
        await store.addMessage(session.id, userMessage("hello"));
        await store.addMessage(session.id, assistantMessage("hi"));
      } finally { unsubscribe(); }
      expect(seen).toHaveLength(2);
      expect(seen[0].messageId).toBeTruthy();
    });

    it("emits when SDK writes via the shared SessionManager (post-getSessionManager)", async () => {
      const session = await store.create("agent-1");
      const seen: number[] = [];
      const unsubscribe = store.subscribe(session.id, () => seen.push(1));
      try {
        const sm = await store.getSessionManager(session.id);
        // Simulate SDK-side write through the patched appendMessage.
        sm!.appendMessage(userMessage("from-sdk") as never);
      } finally { unsubscribe(); }
      expect(seen).toHaveLength(1);
    });

    it("fans out to multiple subscribers", async () => {
      const session = await store.create("agent-1");
      const a: number[] = [];
      const b: number[] = [];
      const ua = store.subscribe(session.id, () => a.push(1));
      const ub = store.subscribe(session.id, () => b.push(1));
      try {
        await store.addMessage(session.id, userMessage("hi"));
      } finally { ua(); ub(); }
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it("unsubscribe stops only that listener", async () => {
      const session = await store.create("agent-1");
      const a: number[] = [];
      const b: number[] = [];
      const ua = store.subscribe(session.id, () => a.push(1));
      const ub = store.subscribe(session.id, () => b.push(1));
      await store.addMessage(session.id, userMessage("first"));
      ua();
      await store.addMessage(session.id, userMessage("second"));
      ub();
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(2);
    });

    it("does not emit after unsubscribe", async () => {
      const session = await store.create("agent-1");
      const seen: number[] = [];
      const unsubscribe = store.subscribe(session.id, () => seen.push(1));
      await store.addMessage(session.id, userMessage("a"));
      unsubscribe();
      await store.addMessage(session.id, userMessage("b"));
      expect(seen).toHaveLength(1);
    });

    it("isolates listeners between sessions", async () => {
      const a = await store.create("agent-1");
      const b = await store.create("agent-1");
      const seenA: number[] = [];
      const seenB: number[] = [];
      const ua = store.subscribe(a.id, () => seenA.push(1));
      const ub = store.subscribe(b.id, () => seenB.push(1));
      try {
        await store.addMessage(a.id, userMessage("for-a"));
        await store.addMessage(b.id, userMessage("for-b"));
        await store.addMessage(b.id, userMessage("for-b-2"));
      } finally { ua(); ub(); }
      expect(seenA).toHaveLength(1);
      expect(seenB).toHaveLength(2);
    });

    it("listener errors do not propagate (turn state safe)", async () => {
      const session = await store.create("agent-1");
      const unsubscribe = store.subscribe(session.id, () => { throw new Error("boom"); });
      try {
        await expect(store.addMessage(session.id, userMessage("hi"))).resolves.not.toThrow();
      } finally { unsubscribe(); }
    });
  });

});
let tmpRoot: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.ISOTOPES_HOME;
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-store-mgr-"));
  process.env.ISOTOPES_HOME = tmpRoot;
});

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.ISOTOPES_HOME;
  } else {
    process.env.ISOTOPES_HOME = originalHome;
  }
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("normalizeAgentId", () => {
  it("lowercases and replaces unsafe chars with -", () => {
    expect(normalizeAgentId("Alice")).toBe("alice");
    expect(normalizeAgentId("subagent:dev:task")).toBe("subagent-dev-task");
    expect(normalizeAgentId("a/b\\c")).toBe("a-b-c");
    expect(normalizeAgentId("code-reviewer_v2")).toBe("code-reviewer_v2");
  });
});

describe("SessionStoreManager.getOrCreate", () => {
  it("creates a store rooted at the per-agent sessions dir", async () => {
    const mgr = new SessionStoreManager();
    const store = await mgr.getOrCreate("alice");
    const expected = getAgentSessionsDir("alice");
    expect(expected).toBe(path.join(tmpRoot, "agents", "alice", "sessions"));
    const stat = await fs.stat(expected);
    expect(stat.isDirectory()).toBe(true);
    expect(store).toBeDefined();
    mgr.destroyAll();
  });

  it("memoizes by normalized id", async () => {
    const mgr = new SessionStoreManager();
    const a = await mgr.getOrCreate("Alice");
    const b = await mgr.getOrCreate("ALICE");
    const c = await mgr.getOrCreate("alice");
    expect(a).toBe(b);
    expect(b).toBe(c);
    mgr.destroyAll();
  });

  it("coalesces concurrent inits for the same id", async () => {
    const mgr = new SessionStoreManager();
    const [a, b] = await Promise.all([
      mgr.getOrCreate("bob"),
      mgr.getOrCreate("bob"),
    ]);
    expect(a).toBe(b);
    mgr.destroyAll();
  });

  it("isolates stores per agent", async () => {
    const mgr = new SessionStoreManager();
    const alice = await mgr.getOrCreate("alice");
    const bob = await mgr.getOrCreate("bob");
    expect(alice).not.toBe(bob);
    mgr.destroyAll();
  });
});

describe("SessionStoreManager.peek + all + destroyAll", () => {
  it("peek returns undefined before getOrCreate", async () => {
    const mgr = new SessionStoreManager();
    expect(mgr.peek("alice")).toBeUndefined();
    await mgr.getOrCreate("alice");
    expect(mgr.peek("Alice")).toBeDefined();
    mgr.destroyAll();
  });

  it("all() snapshots initialized stores", async () => {
    const mgr = new SessionStoreManager();
    await mgr.getOrCreate("alice");
    await mgr.getOrCreate("bob");
    const snap = mgr.all();
    expect(snap.size).toBe(2);
    expect(snap.has("alice")).toBe(true);
    expect(snap.has("bob")).toBe(true);
    mgr.destroyAll();
  });

  it("destroyAll empties the registry", async () => {
    const mgr = new SessionStoreManager();
    await mgr.getOrCreate("alice");
    mgr.destroyAll();
    expect(mgr.all().size).toBe(0);
    expect(mgr.peek("alice")).toBeUndefined();
  });
});
