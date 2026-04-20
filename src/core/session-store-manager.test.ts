// src/core/session-store-manager.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { SessionStoreManager } from "./session-store-manager.js";
import { getAgentSessionsDir, normalizeAgentId } from "./paths.js";

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
