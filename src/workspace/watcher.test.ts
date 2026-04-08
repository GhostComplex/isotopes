// src/workspace/watcher.test.ts — Unit tests for WorkspaceWatcher

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  WorkspaceWatcher,
  globToRegExp,
  matchesPatterns,
  matchesIgnorePatterns,
  type WatcherConfig,
  type FileChange,
} from "./watcher.js";

// ---------------------------------------------------------------------------
// Pure function tests (no I/O)
// ---------------------------------------------------------------------------

describe("globToRegExp", () => {
  it("matches simple wildcards", () => {
    const re = globToRegExp("*.yaml");
    expect(re.test("config.yaml")).toBe(true);
    expect(re.test("test.yaml")).toBe(true);
    expect(re.test("test.json")).toBe(false);
  });

  it("matches ** for recursive paths", () => {
    const re = globToRegExp("**/*.ts");
    expect(re.test("src/index.ts")).toBe(true);
    expect(re.test("src/core/config.ts")).toBe(true);
    expect(re.test("index.ts")).toBe(true);
    expect(re.test("index.js")).toBe(false);
  });

  it("matches ? for single character", () => {
    const re = globToRegExp("file?.txt");
    expect(re.test("file1.txt")).toBe(true);
    expect(re.test("fileA.txt")).toBe(true);
    expect(re.test("file12.txt")).toBe(false);
  });

  it("escapes dots in patterns", () => {
    const re = globToRegExp("*.md");
    expect(re.test("README.md")).toBe(true);
    expect(re.test("READMExmd")).toBe(false);
  });

  it("matches exact filenames", () => {
    const re = globToRegExp("SOUL.md");
    expect(re.test("SOUL.md")).toBe(true);
    expect(re.test("TOOLS.md")).toBe(false);
  });
});

describe("matchesPatterns", () => {
  it("returns true when patterns is undefined", () => {
    expect(matchesPatterns("/some/file.ts")).toBe(true);
  });

  it("returns true when patterns is empty", () => {
    expect(matchesPatterns("/some/file.ts", [])).toBe(true);
  });

  it("matches basename against simple patterns", () => {
    expect(matchesPatterns("/workspace/config.yaml", ["*.yaml"])).toBe(true);
    expect(matchesPatterns("/workspace/config.json", ["*.yaml"])).toBe(false);
  });

  it("matches full path against patterns with /", () => {
    expect(matchesPatterns("src/core/config.ts", ["src/**/*.ts"])).toBe(true);
  });

  it("matches any of multiple patterns", () => {
    expect(matchesPatterns("/a/b.yaml", ["*.yaml", "*.md"])).toBe(true);
    expect(matchesPatterns("/a/b.md", ["*.yaml", "*.md"])).toBe(true);
    expect(matchesPatterns("/a/b.json", ["*.yaml", "*.md"])).toBe(false);
  });
});

describe("matchesIgnorePatterns", () => {
  it("returns false when ignorePatterns is undefined", () => {
    expect(matchesIgnorePatterns("/some/file.ts")).toBe(false);
  });

  it("returns false when ignorePatterns is empty", () => {
    expect(matchesIgnorePatterns("/some/file.ts", [])).toBe(false);
  });

  it("matches path segments against ignore patterns", () => {
    expect(
      matchesIgnorePatterns("/project/node_modules/pkg/index.js", ["node_modules"]),
    ).toBe(true);
  });

  it("matches .git directories", () => {
    expect(matchesIgnorePatterns("/project/.git/HEAD", [".git"])).toBe(true);
  });

  it("does not ignore unrelated paths", () => {
    expect(matchesIgnorePatterns("/project/src/index.ts", ["node_modules"])).toBe(false);
  });

  it("supports multiple ignore patterns", () => {
    expect(
      matchesIgnorePatterns("/project/node_modules/a.js", ["node_modules", ".git"]),
    ).toBe(true);
    expect(
      matchesIgnorePatterns("/project/.git/HEAD", ["node_modules", ".git"]),
    ).toBe(true);
    expect(
      matchesIgnorePatterns("/project/src/a.ts", ["node_modules", ".git"]),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorkspaceWatcher integration tests (uses real fs.watch)
// ---------------------------------------------------------------------------

describe("WorkspaceWatcher", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "isotopes-watcher-"));
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  function makeConfig(overrides?: Partial<WatcherConfig>): WatcherConfig {
    return {
      paths: [tempDir],
      debounceMs: 50,
      ...overrides,
    };
  }

  // -----------------------------------------------------------------------
  // start / stop / isWatching
  // -----------------------------------------------------------------------

  describe("start / stop", () => {
    it("starts and reports isWatching true", () => {
      const watcher = new WorkspaceWatcher(makeConfig());
      watcher.start();

      expect(watcher.isWatching()).toBe(true);

      watcher.stop();
    });

    it("stops and reports isWatching false", () => {
      const watcher = new WorkspaceWatcher(makeConfig());
      watcher.start();
      watcher.stop();

      expect(watcher.isWatching()).toBe(false);
    });

    it("start is idempotent", () => {
      const watcher = new WorkspaceWatcher(makeConfig());
      watcher.start();
      watcher.start(); // should not throw or double-watch

      expect(watcher.isWatching()).toBe(true);

      watcher.stop();
    });

    it("stop is idempotent", () => {
      const watcher = new WorkspaceWatcher(makeConfig());
      watcher.stop(); // should not throw when not started
      watcher.start();
      watcher.stop();
      watcher.stop(); // should not throw when already stopped
    });
  });

  // -----------------------------------------------------------------------
  // File change detection
  // -----------------------------------------------------------------------

  describe("file change detection", () => {
    it("detects file creation", async () => {
      const watcher = new WorkspaceWatcher(makeConfig());
      const changes: FileChange[] = [];

      watcher.onChange((c) => {
        changes.push(...c);
      });
      watcher.start();

      // Create a file
      await fsp.writeFile(path.join(tempDir, "new-file.txt"), "hello");

      // Wait for debounce + fs.watch delay
      await new Promise((r) => setTimeout(r, 300));

      watcher.stop();

      expect(changes.length).toBeGreaterThanOrEqual(1);
      expect(changes.some((c) => c.path.includes("new-file.txt"))).toBe(true);
    });

    it("detects file modification", async () => {
      // Create initial file
      const filePath = path.join(tempDir, "existing.txt");
      await fsp.writeFile(filePath, "initial");

      const watcher = new WorkspaceWatcher(makeConfig());
      const changes: FileChange[] = [];

      watcher.onChange((c) => {
        changes.push(...c);
      });
      watcher.start();

      // Wait briefly for watcher to stabilize
      await new Promise((r) => setTimeout(r, 100));

      // Modify the file
      await fsp.writeFile(filePath, "modified");

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 300));

      watcher.stop();

      expect(changes.length).toBeGreaterThanOrEqual(1);
      expect(changes.some((c) => c.path.includes("existing.txt"))).toBe(true);
    });

    it("detects file deletion", async () => {
      // Create initial file
      const filePath = path.join(tempDir, "to-delete.txt");
      await fsp.writeFile(filePath, "temporary");

      const watcher = new WorkspaceWatcher(makeConfig());
      const changes: FileChange[] = [];

      watcher.onChange((c) => {
        changes.push(...c);
      });
      watcher.start();

      // Wait briefly for watcher to stabilize
      await new Promise((r) => setTimeout(r, 100));

      // Delete the file
      await fsp.unlink(filePath);

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 300));

      watcher.stop();

      expect(changes.length).toBeGreaterThanOrEqual(1);
      expect(changes.some((c) => c.path.includes("to-delete.txt"))).toBe(true);
      expect(changes.some((c) => c.type === "unlink")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Debouncing
  // -----------------------------------------------------------------------

  describe("debouncing", () => {
    it("batches rapid changes into a single notification", async () => {
      const watcher = new WorkspaceWatcher(makeConfig({ debounceMs: 100 }));
      let callCount = 0;

      watcher.onChange(() => {
        callCount++;
      });
      watcher.start();

      // Write multiple files rapidly
      await fsp.writeFile(path.join(tempDir, "a.txt"), "a");
      await fsp.writeFile(path.join(tempDir, "b.txt"), "b");
      await fsp.writeFile(path.join(tempDir, "c.txt"), "c");

      // Wait for single debounce flush
      await new Promise((r) => setTimeout(r, 400));

      watcher.stop();

      // Should have been called once (batched), not three times
      // Note: fs.watch behavior varies by OS, so we check <= 2 to be safe
      expect(callCount).toBeLessThanOrEqual(2);
    });
  });

  // -----------------------------------------------------------------------
  // Pattern matching
  // -----------------------------------------------------------------------

  describe("pattern matching", () => {
    it("only notifies for files matching include patterns", async () => {
      const watcher = new WorkspaceWatcher(
        makeConfig({ patterns: ["*.yaml"] }),
      );
      const changes: FileChange[] = [];

      watcher.onChange((c) => {
        changes.push(...c);
      });
      watcher.start();

      // Write a matching and non-matching file
      await fsp.writeFile(path.join(tempDir, "config.yaml"), "key: value");
      await fsp.writeFile(path.join(tempDir, "readme.txt"), "hello");

      await new Promise((r) => setTimeout(r, 300));

      watcher.stop();

      // Only the yaml file should have been reported
      const yamlChanges = changes.filter((c) => c.path.endsWith(".yaml"));
      const txtChanges = changes.filter((c) => c.path.endsWith(".txt"));

      expect(yamlChanges.length).toBeGreaterThanOrEqual(1);
      expect(txtChanges.length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Multiple handlers
  // -----------------------------------------------------------------------

  describe("multiple handlers", () => {
    it("notifies all registered handlers", async () => {
      const watcher = new WorkspaceWatcher(makeConfig());
      const handler1Changes: FileChange[] = [];
      const handler2Changes: FileChange[] = [];

      watcher.onChange((c) => { handler1Changes.push(...c); });
      watcher.onChange((c) => { handler2Changes.push(...c); });
      watcher.start();

      await fsp.writeFile(path.join(tempDir, "test.txt"), "test");

      await new Promise((r) => setTimeout(r, 300));

      watcher.stop();

      expect(handler1Changes.length).toBeGreaterThanOrEqual(1);
      expect(handler2Changes.length).toBeGreaterThanOrEqual(1);
    });

    it("unsubscribe removes only that handler", async () => {
      const watcher = new WorkspaceWatcher(makeConfig());
      const handler1Changes: FileChange[] = [];
      const handler2Changes: FileChange[] = [];

      const unsub1 = watcher.onChange((c) => { handler1Changes.push(...c); });
      watcher.onChange((c) => { handler2Changes.push(...c); });

      unsub1(); // Unsubscribe handler1

      watcher.start();

      await fsp.writeFile(path.join(tempDir, "test.txt"), "test");

      await new Promise((r) => setTimeout(r, 300));

      watcher.stop();

      expect(handler1Changes.length).toBe(0);
      expect(handler2Changes.length).toBeGreaterThanOrEqual(1);
    });

    it("handles errors in one handler without affecting others", async () => {
      const watcher = new WorkspaceWatcher(makeConfig());
      const goodHandlerChanges: FileChange[] = [];

      watcher.onChange(() => {
        throw new Error("handler error");
      });
      watcher.onChange((c) => { goodHandlerChanges.push(...c); });

      watcher.start();

      await fsp.writeFile(path.join(tempDir, "test.txt"), "test");

      await new Promise((r) => setTimeout(r, 300));

      watcher.stop();

      expect(goodHandlerChanges.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Ignore patterns
  // -----------------------------------------------------------------------

  describe("ignore patterns", () => {
    it("ignores files in ignored directories", async () => {
      const ignoredDir = path.join(tempDir, "node_modules");
      await fsp.mkdir(ignoredDir, { recursive: true });

      const watcher = new WorkspaceWatcher(
        makeConfig({ ignorePatterns: ["node_modules"] }),
      );
      const changes: FileChange[] = [];

      watcher.onChange((c) => { changes.push(...c); });
      watcher.start();

      // Write to ignored dir and normal dir
      await fsp.writeFile(path.join(ignoredDir, "pkg.json"), "{}");
      await fsp.writeFile(path.join(tempDir, "index.ts"), "code");

      await new Promise((r) => setTimeout(r, 300));

      watcher.stop();

      // Only the non-ignored file should be reported
      const ignoredChanges = changes.filter((c) =>
        c.path.includes("node_modules"),
      );
      expect(ignoredChanges.length).toBe(0);

      const normalChanges = changes.filter((c) =>
        c.path.includes("index.ts"),
      );
      expect(normalChanges.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // FileChange properties
  // -----------------------------------------------------------------------

  describe("FileChange properties", () => {
    it("includes timestamp on each change", async () => {
      const watcher = new WorkspaceWatcher(makeConfig());
      const changes: FileChange[] = [];

      watcher.onChange((c) => { changes.push(...c); });
      watcher.start();

      const before = new Date();
      await fsp.writeFile(path.join(tempDir, "timestamped.txt"), "data");

      await new Promise((r) => setTimeout(r, 300));

      watcher.stop();

      expect(changes.length).toBeGreaterThanOrEqual(1);
      for (const change of changes) {
        expect(change.timestamp).toBeInstanceOf(Date);
        expect(change.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      }
    });

    it("includes absolute path", async () => {
      const watcher = new WorkspaceWatcher(makeConfig());
      const changes: FileChange[] = [];

      watcher.onChange((c) => { changes.push(...c); });
      watcher.start();

      await fsp.writeFile(path.join(tempDir, "abs-test.txt"), "data");

      await new Promise((r) => setTimeout(r, 300));

      watcher.stop();

      expect(changes.length).toBeGreaterThanOrEqual(1);
      for (const change of changes) {
        expect(path.isAbsolute(change.path)).toBe(true);
      }
    });
  });
});
