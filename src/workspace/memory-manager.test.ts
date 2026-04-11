// src/workspace/memory-manager.test.ts — Tests for MemoryManager

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryManager } from "./memory-manager.js";

describe("MemoryManager", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "memory-mgr-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // appendMemory
  // -------------------------------------------------------------------------

  describe("appendMemory", () => {
    it("creates MEMORY.md if it does not exist", async () => {
      const mgr = new MemoryManager(tempDir);
      const result = await mgr.appendMemory("first entry");

      expect(result.success).toBe(true);
      expect(result.filePath).toBe(path.join(tempDir, "MEMORY.md"));

      const content = await fsp.readFile(path.join(tempDir, "MEMORY.md"), "utf-8");
      expect(content).toContain("first entry");
      // Should include timestamp
      expect(content).toMatch(/^- \[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("appends to existing MEMORY.md", async () => {
      await fsp.writeFile(path.join(tempDir, "MEMORY.md"), "- existing entry");

      const mgr = new MemoryManager(tempDir);
      const result = await mgr.appendMemory("new entry");

      expect(result.success).toBe(true);

      const content = await fsp.readFile(path.join(tempDir, "MEMORY.md"), "utf-8");
      expect(content).toContain("- existing entry");
      expect(content).toContain("new entry");
    });

    it("creates backup when appending to existing file", async () => {
      await fsp.writeFile(path.join(tempDir, "MEMORY.md"), "original");

      const mgr = new MemoryManager(tempDir);
      const result = await mgr.appendMemory("addition");

      expect(result.backupPath).toBe(path.join(tempDir, "MEMORY.md.bak"));

      const backup = await fsp.readFile(result.backupPath!, "utf-8");
      expect(backup).toBe("original");
    });

    it("skips backup when disabled", async () => {
      await fsp.writeFile(path.join(tempDir, "MEMORY.md"), "original");

      const mgr = new MemoryManager(tempDir, { backup: false });
      const result = await mgr.appendMemory("addition");

      expect(result.success).toBe(true);
      expect(result.backupPath).toBeUndefined();

      await expect(
        fsp.stat(path.join(tempDir, "MEMORY.md.bak")),
      ).rejects.toThrow();
    });

    it("does not create backup for new files", async () => {
      const mgr = new MemoryManager(tempDir);
      const result = await mgr.appendMemory("first");

      expect(result.success).toBe(true);
      expect(result.backupPath).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // appendDailyNote
  // -------------------------------------------------------------------------

  describe("appendDailyNote", () => {
    it("creates memory directory and daily note file", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-12T14:30:00Z"));

      const mgr = new MemoryManager(tempDir);
      const result = await mgr.appendDailyNote("daily observation");

      expect(result.success).toBe(true);
      expect(result.filePath).toBe(
        path.join(tempDir, "memory", "2026-04-12.md"),
      );

      const content = await fsp.readFile(result.filePath, "utf-8");
      expect(content).toContain("daily observation");
      // Should have time-only timestamp
      expect(content).toMatch(/^- \[\d{2}:\d{2}:\d{2}/);
    });

    it("appends to existing daily note", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-12T10:00:00Z"));

      await fsp.mkdir(path.join(tempDir, "memory"), { recursive: true });
      await fsp.writeFile(
        path.join(tempDir, "memory/2026-04-12.md"),
        "- [10:00:00.000] morning note",
      );

      vi.setSystemTime(new Date("2026-04-12T14:30:00Z"));

      const mgr = new MemoryManager(tempDir);
      const result = await mgr.appendDailyNote("afternoon note");

      expect(result.success).toBe(true);

      const content = await fsp.readFile(
        path.join(tempDir, "memory/2026-04-12.md"),
        "utf-8",
      );
      expect(content).toContain("morning note");
      expect(content).toContain("afternoon note");
    });

    it("creates backup when appending to existing note", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-12T14:00:00Z"));

      await fsp.mkdir(path.join(tempDir, "memory"), { recursive: true });
      await fsp.writeFile(
        path.join(tempDir, "memory/2026-04-12.md"),
        "original",
      );

      const mgr = new MemoryManager(tempDir);
      const result = await mgr.appendDailyNote("addition");

      expect(result.backupPath).toBe(
        path.join(tempDir, "memory/2026-04-12.md.bak"),
      );
    });
  });

  // -------------------------------------------------------------------------
  // readMemory
  // -------------------------------------------------------------------------

  describe("readMemory", () => {
    it("returns null when MEMORY.md does not exist", async () => {
      const mgr = new MemoryManager(tempDir);
      expect(await mgr.readMemory()).toBeNull();
    });

    it("returns content of MEMORY.md", async () => {
      await fsp.writeFile(path.join(tempDir, "MEMORY.md"), "my memories");

      const mgr = new MemoryManager(tempDir);
      expect(await mgr.readMemory()).toBe("my memories");
    });
  });

  // -------------------------------------------------------------------------
  // readDailyNote
  // -------------------------------------------------------------------------

  describe("readDailyNote", () => {
    it("returns null when note does not exist", async () => {
      const mgr = new MemoryManager(tempDir);
      expect(await mgr.readDailyNote("2026-04-12")).toBeNull();
    });

    it("reads note by date string", async () => {
      await fsp.mkdir(path.join(tempDir, "memory"), { recursive: true });
      await fsp.writeFile(
        path.join(tempDir, "memory/2026-04-12.md"),
        "today's content",
      );

      const mgr = new MemoryManager(tempDir);
      expect(await mgr.readDailyNote("2026-04-12")).toBe("today's content");
    });

    it("reads note by Date object", async () => {
      await fsp.mkdir(path.join(tempDir, "memory"), { recursive: true });
      await fsp.writeFile(
        path.join(tempDir, "memory/2026-04-12.md"),
        "date object note",
      );

      const mgr = new MemoryManager(tempDir);
      const result = await mgr.readDailyNote(new Date("2026-04-12T12:00:00Z"));
      expect(result).toBe("date object note");
    });
  });

  // -------------------------------------------------------------------------
  // listDailyNotes
  // -------------------------------------------------------------------------

  describe("listDailyNotes", () => {
    it("returns empty array when memory directory does not exist", async () => {
      const mgr = new MemoryManager(tempDir);
      expect(await mgr.listDailyNotes()).toEqual([]);
    });

    it("returns sorted daily note filenames", async () => {
      const memDir = path.join(tempDir, "memory");
      await fsp.mkdir(memDir, { recursive: true });
      await fsp.writeFile(path.join(memDir, "2026-04-12.md"), "a");
      await fsp.writeFile(path.join(memDir, "2026-04-10.md"), "b");
      await fsp.writeFile(path.join(memDir, "2026-04-11.md"), "c");

      const mgr = new MemoryManager(tempDir);
      const notes = await mgr.listDailyNotes();

      expect(notes).toEqual([
        "2026-04-10.md",
        "2026-04-11.md",
        "2026-04-12.md",
      ]);
    });

    it("filters out non-date files", async () => {
      const memDir = path.join(tempDir, "memory");
      await fsp.mkdir(memDir, { recursive: true });
      await fsp.writeFile(path.join(memDir, "2026-04-12.md"), "note");
      await fsp.writeFile(path.join(memDir, "random.md"), "not a daily note");
      await fsp.writeFile(path.join(memDir, "MEMORY.md.bak"), "backup");

      const mgr = new MemoryManager(tempDir);
      const notes = await mgr.listDailyNotes();

      expect(notes).toEqual(["2026-04-12.md"]);
    });
  });

  // -------------------------------------------------------------------------
  // ensureMemoryDir
  // -------------------------------------------------------------------------

  describe("ensureMemoryDir", () => {
    it("creates memory directory", async () => {
      const mgr = new MemoryManager(tempDir);
      await mgr.ensureMemoryDir();

      const stat = await fsp.stat(path.join(tempDir, "memory"));
      expect(stat.isDirectory()).toBe(true);
    });

    it("does not throw if directory already exists", async () => {
      await fsp.mkdir(path.join(tempDir, "memory"), { recursive: true });

      const mgr = new MemoryManager(tempDir);
      await expect(mgr.ensureMemoryDir()).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // getWorkspacePath
  // -------------------------------------------------------------------------

  describe("getWorkspacePath", () => {
    it("returns the configured workspace path", () => {
      const mgr = new MemoryManager("/my/workspace");
      expect(mgr.getWorkspacePath()).toBe("/my/workspace");
    });
  });
});
