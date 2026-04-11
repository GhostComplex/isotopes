// src/workspace/context-loader.test.ts — Tests for WorkspaceContextLoader

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WorkspaceContextLoader, CONTEXT_FILES, MEMORY_FILES } from "./context-loader.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("CONTEXT_FILES", () => {
  it("includes standard workspace files", () => {
    expect(CONTEXT_FILES).toContain("SOUL.md");
    expect(CONTEXT_FILES).toContain("IDENTITY.md");
    expect(CONTEXT_FILES).toContain("USER.md");
    expect(CONTEXT_FILES).toContain("TOOLS.md");
    expect(CONTEXT_FILES).toContain("AGENTS.md");
    expect(CONTEXT_FILES).toContain("BOOTSTRAP.md");
  });
});

describe("MEMORY_FILES", () => {
  it("includes MEMORY.md", () => {
    expect(MEMORY_FILES).toContain("MEMORY.md");
  });
});

// ---------------------------------------------------------------------------
// WorkspaceContextLoader
// ---------------------------------------------------------------------------

describe("WorkspaceContextLoader", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ctx-loader-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  describe("load", () => {
    it("returns empty context for empty workspace", async () => {
      const loader = new WorkspaceContextLoader(tempDir);
      const ctx = await loader.load();

      expect(ctx.systemPromptAdditions).toBe("");
      expect(ctx.memory).toBeNull();
      expect(ctx.workspacePath).toBe(tempDir);
      expect(ctx.files.size).toBe(0);
      expect(ctx.loadedAt).toBeInstanceOf(Date);
    });

    it("loads SOUL.md into systemPromptAdditions", async () => {
      await fsp.writeFile(path.join(tempDir, "SOUL.md"), "# My Soul");

      const loader = new WorkspaceContextLoader(tempDir);
      const ctx = await loader.load();

      expect(ctx.systemPromptAdditions).toContain("## SOUL.md");
      expect(ctx.systemPromptAdditions).toContain("# My Soul");
      expect(ctx.files.get("SOUL.md")).toBe("# My Soul");
    });

    it("loads multiple workspace files", async () => {
      await fsp.writeFile(path.join(tempDir, "SOUL.md"), "soul content");
      await fsp.writeFile(path.join(tempDir, "IDENTITY.md"), "identity content");
      await fsp.writeFile(path.join(tempDir, "TOOLS.md"), "tools content");

      const loader = new WorkspaceContextLoader(tempDir);
      const ctx = await loader.load();

      expect(ctx.systemPromptAdditions).toContain("## SOUL.md");
      expect(ctx.systemPromptAdditions).toContain("## IDENTITY.md");
      expect(ctx.systemPromptAdditions).toContain("## TOOLS.md");
      expect(ctx.files.size).toBe(3);
    });

    it("loads MEMORY.md into memory field", async () => {
      await fsp.writeFile(path.join(tempDir, "MEMORY.md"), "remembered things");

      const loader = new WorkspaceContextLoader(tempDir);
      const ctx = await loader.load();

      expect(ctx.memory).toBe("remembered things");
      expect(ctx.files.get("MEMORY.md")).toBe("remembered things");
      // MEMORY.md should NOT be in systemPromptAdditions
      expect(ctx.systemPromptAdditions).not.toContain("MEMORY.md");
    });

    it("loads daily note and merges with MEMORY.md", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-12T10:00:00Z"));

      await fsp.writeFile(path.join(tempDir, "MEMORY.md"), "long-term memory");
      await fsp.mkdir(path.join(tempDir, "memory"), { recursive: true });
      await fsp.writeFile(
        path.join(tempDir, "memory/2026-04-12.md"),
        "today's notes",
      );

      const loader = new WorkspaceContextLoader(tempDir);
      const ctx = await loader.load();

      expect(ctx.memory).toContain("long-term memory");
      expect(ctx.memory).toContain("Today's Notes");
      expect(ctx.memory).toContain("today's notes");
    });

    it("loads daily note alone when no MEMORY.md", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-12T10:00:00Z"));

      await fsp.mkdir(path.join(tempDir, "memory"), { recursive: true });
      await fsp.writeFile(
        path.join(tempDir, "memory/2026-04-12.md"),
        "standalone daily note",
      );

      const loader = new WorkspaceContextLoader(tempDir);
      const ctx = await loader.load();

      expect(ctx.memory).toBe("standalone daily note");
    });

    it("ignores daily notes from other dates", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-12T10:00:00Z"));

      await fsp.mkdir(path.join(tempDir, "memory"), { recursive: true });
      await fsp.writeFile(
        path.join(tempDir, "memory/2026-04-11.md"),
        "yesterday's notes",
      );

      const loader = new WorkspaceContextLoader(tempDir);
      const ctx = await loader.load();

      expect(ctx.memory).toBeNull();
    });
  });

  describe("refresh", () => {
    it("re-reads files from disk", async () => {
      await fsp.writeFile(path.join(tempDir, "SOUL.md"), "version 1");

      const loader = new WorkspaceContextLoader(tempDir);
      await loader.load();

      expect(loader.getFile("SOUL.md")).toBe("version 1");

      // Update file on disk
      await fsp.writeFile(path.join(tempDir, "SOUL.md"), "version 2");

      const ctx = await loader.refresh();

      expect(ctx.files.get("SOUL.md")).toBe("version 2");
      expect(loader.getFile("SOUL.md")).toBe("version 2");
    });

    it("picks up newly created files", async () => {
      const loader = new WorkspaceContextLoader(tempDir);
      await loader.load();

      expect(loader.getFile("SOUL.md")).toBeNull();

      await fsp.writeFile(path.join(tempDir, "SOUL.md"), "new soul");
      await loader.refresh();

      expect(loader.getFile("SOUL.md")).toBe("new soul");
    });

    it("detects deleted files", async () => {
      await fsp.writeFile(path.join(tempDir, "SOUL.md"), "soul content");

      const loader = new WorkspaceContextLoader(tempDir);
      await loader.load();

      expect(loader.getFile("SOUL.md")).toBe("soul content");

      await fsp.unlink(path.join(tempDir, "SOUL.md"));
      await loader.refresh();

      expect(loader.getFile("SOUL.md")).toBeNull();
    });
  });

  describe("getContext", () => {
    it("returns null before load", () => {
      const loader = new WorkspaceContextLoader(tempDir);
      expect(loader.getContext()).toBeNull();
    });

    it("returns cached context after load", async () => {
      const loader = new WorkspaceContextLoader(tempDir);
      const ctx = await loader.load();

      expect(loader.getContext()).toBe(ctx);
    });
  });

  describe("getFile", () => {
    it("returns null before load", () => {
      const loader = new WorkspaceContextLoader(tempDir);
      expect(loader.getFile("SOUL.md")).toBeNull();
    });

    it("returns null for non-existent file", async () => {
      const loader = new WorkspaceContextLoader(tempDir);
      await loader.load();

      expect(loader.getFile("NONEXISTENT.md")).toBeNull();
    });
  });

  describe("buildSystemPrompt", () => {
    it("returns base prompt when context not loaded", () => {
      const loader = new WorkspaceContextLoader(tempDir);
      const result = loader.buildSystemPrompt("base prompt");

      expect(result).toBe("base prompt");
    });

    it("combines base prompt with workspace context", async () => {
      await fsp.writeFile(path.join(tempDir, "SOUL.md"), "soul content");

      const loader = new WorkspaceContextLoader(tempDir);
      await loader.load();

      const result = loader.buildSystemPrompt("You are an agent.");

      expect(result).toContain("You are an agent.");
      expect(result).toContain("# Workspace");
      expect(result).toContain(tempDir);
      expect(result).toContain("# Workspace Context");
      expect(result).toContain("soul content");
    });

    it("includes memory section when MEMORY.md exists", async () => {
      await fsp.writeFile(path.join(tempDir, "MEMORY.md"), "my memory");

      const loader = new WorkspaceContextLoader(tempDir);
      await loader.load();

      const result = loader.buildSystemPrompt("base");

      expect(result).toContain("# Memory");
      expect(result).toContain("my memory");
    });

    it("uses --- separators between sections", async () => {
      await fsp.writeFile(path.join(tempDir, "SOUL.md"), "soul");

      const loader = new WorkspaceContextLoader(tempDir);
      await loader.load();

      const result = loader.buildSystemPrompt("base");

      expect(result).toContain("\n\n---\n\n");
    });
  });

  describe("getWorkspacePath", () => {
    it("returns the configured workspace path", () => {
      const loader = new WorkspaceContextLoader("/my/workspace");
      expect(loader.getWorkspacePath()).toBe("/my/workspace");
    });
  });
});
