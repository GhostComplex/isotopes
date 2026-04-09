// src/workspace/writer.test.ts — Unit tests for workspace writer

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  writeWorkspaceFile,
  appendToMemory,
  appendToDailyNote,
  validatePath,
  isAllowedFile,
  type WorkspaceWriteOptions,
} from "./writer.js";

// ---------------------------------------------------------------------------
// Path validation tests (pure functions)
// ---------------------------------------------------------------------------

describe("validatePath", () => {
  it("accepts simple filenames", () => {
    expect(() => validatePath("SOUL.md")).not.toThrow();
    expect(() => validatePath("MEMORY.md")).not.toThrow();
  });

  it("accepts nested paths", () => {
    expect(() => validatePath("memory/2024-01-15.md")).not.toThrow();
    expect(() => validatePath("skills/my-skill/SKILL.md")).not.toThrow();
  });

  it("rejects absolute paths", () => {
    expect(() => validatePath("/etc/passwd")).toThrow("Absolute paths are not allowed");
    expect(() => validatePath("/home/user/file.md")).toThrow("Absolute paths are not allowed");
  });

  it("rejects .. path traversal", () => {
    expect(() => validatePath("../outside.md")).toThrow("Path traversal not allowed");
    expect(() => validatePath("memory/../../../etc/passwd")).toThrow("Path traversal not allowed");
    expect(() => validatePath("foo/bar/../../baz/../../../etc")).toThrow("Path traversal not allowed");
  });

  it("rejects hidden traversal attempts", () => {
    expect(() => validatePath("..")).toThrow("Path traversal not allowed");
    expect(() => validatePath("foo/..")).toThrow("Path traversal not allowed");
    expect(() => validatePath("./..")).toThrow("Path traversal not allowed");
  });
});

describe("isAllowedFile", () => {
  const patterns = ["SOUL.md", "AGENTS.md", "TOOLS.md", "MEMORY.md", "memory/*.md"];

  it("allows exact matches", () => {
    expect(isAllowedFile("SOUL.md", patterns)).toBe(true);
    expect(isAllowedFile("MEMORY.md", patterns)).toBe(true);
  });

  it("allows glob pattern matches", () => {
    expect(isAllowedFile("memory/2024-01-15.md", patterns)).toBe(true);
    expect(isAllowedFile("memory/notes.md", patterns)).toBe(true);
  });

  it("rejects non-matching files", () => {
    expect(isAllowedFile("config.yaml", patterns)).toBe(false);
    expect(isAllowedFile("src/index.ts", patterns)).toBe(false);
    expect(isAllowedFile("README.md", patterns)).toBe(false);
  });

  it("rejects nested paths not matching patterns", () => {
    expect(isAllowedFile("other/SOUL.md", patterns)).toBe(false);
    expect(isAllowedFile("deep/memory/file.md", patterns)).toBe(false);
  });

  it("handles ** recursive patterns", () => {
    const recursivePatterns = ["skills/**/*.md"];
    expect(isAllowedFile("skills/foo/SKILL.md", recursivePatterns)).toBe(true);
    expect(isAllowedFile("skills/bar/baz/README.md", recursivePatterns)).toBe(true);
    expect(isAllowedFile("other/skills/foo.md", recursivePatterns)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Write function tests (use real filesystem)
// ---------------------------------------------------------------------------

describe("writeWorkspaceFile", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "isotopes-writer-"));
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  function makeOptions(overrides?: Partial<WorkspaceWriteOptions>): WorkspaceWriteOptions {
    return {
      workspacePath: tempDir,
      ...overrides,
    };
  }

  it("writes a new file", async () => {
    const result = await writeWorkspaceFile("SOUL.md", "# Soul\nTest content", makeOptions());

    expect(result.success).toBe(true);
    expect(result.backupPath).toBeUndefined(); // No backup for new files

    const content = await fsp.readFile(path.join(tempDir, "SOUL.md"), "utf-8");
    expect(content).toBe("# Soul\nTest content");
  });

  it("creates backup before overwriting", async () => {
    // Create initial file
    await fsp.writeFile(path.join(tempDir, "SOUL.md"), "Original content");

    const result = await writeWorkspaceFile("SOUL.md", "New content", makeOptions());

    expect(result.success).toBe(true);
    expect(result.backupPath).toBe(path.join(tempDir, "SOUL.md.bak"));

    // Check backup exists with original content
    const backupContent = await fsp.readFile(result.backupPath!, "utf-8");
    expect(backupContent).toBe("Original content");

    // Check new file has new content
    const newContent = await fsp.readFile(path.join(tempDir, "SOUL.md"), "utf-8");
    expect(newContent).toBe("New content");
  });

  it("skips backup when disabled", async () => {
    // Create initial file
    await fsp.writeFile(path.join(tempDir, "SOUL.md"), "Original content");

    const result = await writeWorkspaceFile("SOUL.md", "New content", makeOptions({ backup: false }));

    expect(result.success).toBe(true);
    expect(result.backupPath).toBeUndefined();

    // Check no backup file created
    await expect(fsp.stat(path.join(tempDir, "SOUL.md.bak"))).rejects.toThrow();
  });

  it("creates parent directories", async () => {
    const result = await writeWorkspaceFile(
      "memory/2024-01-15.md",
      "Daily note",
      makeOptions(),
    );

    expect(result.success).toBe(true);

    const content = await fsp.readFile(path.join(tempDir, "memory/2024-01-15.md"), "utf-8");
    expect(content).toBe("Daily note");
  });

  it("rejects path traversal attempts", async () => {
    const result = await writeWorkspaceFile("../escape.md", "malicious", makeOptions());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Path traversal not allowed");
  });

  it("rejects absolute paths", async () => {
    const result = await writeWorkspaceFile("/etc/passwd", "malicious", makeOptions());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Absolute paths are not allowed");
  });

  it("rejects files not in allowedFiles", async () => {
    const result = await writeWorkspaceFile("config.yaml", "key: value", makeOptions());

    expect(result.success).toBe(false);
    expect(result.error).toContain("File not in allowed list");
  });

  it("respects custom allowedFiles", async () => {
    const result = await writeWorkspaceFile(
      "custom.txt",
      "custom content",
      makeOptions({ allowedFiles: ["*.txt"] }),
    );

    expect(result.success).toBe(true);
    const content = await fsp.readFile(path.join(tempDir, "custom.txt"), "utf-8");
    expect(content).toBe("custom content");
  });
});

describe("appendToMemory", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "isotopes-writer-"));
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  function makeOptions(overrides?: Partial<WorkspaceWriteOptions>): WorkspaceWriteOptions {
    return {
      workspacePath: tempDir,
      ...overrides,
    };
  }

  it("creates MEMORY.md if it does not exist", async () => {
    const result = await appendToMemory("First entry", makeOptions());

    expect(result.success).toBe(true);
    expect(result.backupPath).toBeUndefined();

    const content = await fsp.readFile(path.join(tempDir, "MEMORY.md"), "utf-8");
    expect(content).toBe("First entry");
  });

  it("appends to existing MEMORY.md with newline", async () => {
    await fsp.writeFile(path.join(tempDir, "MEMORY.md"), "Existing content");

    const result = await appendToMemory("New entry", makeOptions());

    expect(result.success).toBe(true);
    expect(result.backupPath).toBeDefined();

    const content = await fsp.readFile(path.join(tempDir, "MEMORY.md"), "utf-8");
    expect(content).toBe("Existing content\nNew entry");
  });

  it("creates backup when appending", async () => {
    await fsp.writeFile(path.join(tempDir, "MEMORY.md"), "Original");

    const result = await appendToMemory("Appended", makeOptions());

    expect(result.backupPath).toBe(path.join(tempDir, "MEMORY.md.bak"));
    const backupContent = await fsp.readFile(result.backupPath!, "utf-8");
    expect(backupContent).toBe("Original");
  });

  it("respects allowedFiles restriction", async () => {
    const result = await appendToMemory("content", makeOptions({ allowedFiles: ["SOUL.md"] }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("File not in allowed list");
  });
});

describe("appendToDailyNote", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "isotopes-writer-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  function makeOptions(overrides?: Partial<WorkspaceWriteOptions>): WorkspaceWriteOptions {
    return {
      workspacePath: tempDir,
      ...overrides,
    };
  }

  it("creates memory directory and daily note", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-15T12:00:00Z"));

    const result = await appendToDailyNote("Daily entry", makeOptions());

    expect(result.success).toBe(true);

    const content = await fsp.readFile(path.join(tempDir, "memory/2024-03-15.md"), "utf-8");
    expect(content).toBe("Daily entry");
  });

  it("appends to existing daily note", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-15T12:00:00Z"));

    // Create memory dir and initial note
    await fsp.mkdir(path.join(tempDir, "memory"), { recursive: true });
    await fsp.writeFile(path.join(tempDir, "memory/2024-03-15.md"), "Morning entry");

    const result = await appendToDailyNote("Evening entry", makeOptions());

    expect(result.success).toBe(true);
    expect(result.backupPath).toBeDefined();

    const content = await fsp.readFile(path.join(tempDir, "memory/2024-03-15.md"), "utf-8");
    expect(content).toBe("Morning entry\nEvening entry");
  });

  it("creates backup when appending to existing note", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-15T12:00:00Z"));

    await fsp.mkdir(path.join(tempDir, "memory"), { recursive: true });
    await fsp.writeFile(path.join(tempDir, "memory/2024-03-15.md"), "Original");

    const result = await appendToDailyNote("Appended", makeOptions());

    expect(result.backupPath).toBe(path.join(tempDir, "memory/2024-03-15.md.bak"));
    const backupContent = await fsp.readFile(result.backupPath!, "utf-8");
    expect(backupContent).toBe("Original");
  });

  it("uses correct date format YYYY-MM-DD", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-01T08:30:00Z"));

    await appendToDailyNote("Test", makeOptions());

    // Verify file was created with correct date
    const files = await fsp.readdir(path.join(tempDir, "memory"));
    expect(files).toContain("2025-12-01.md");
  });

  it("respects allowedFiles restriction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-15T12:00:00Z"));

    const result = await appendToDailyNote("content", makeOptions({ allowedFiles: ["SOUL.md"] }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("File not in allowed list");
  });
});
