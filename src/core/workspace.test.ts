// src/core/workspace.test.ts — Unit tests for workspace loading

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  loadWorkspaceContext,
  buildSystemPrompt,
  ensureWorkspaceStructure,
  getSessionsDir,
} from "./workspace.js";

describe("Workspace", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-workspace-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("ensureWorkspaceStructure", () => {
    it("creates workspace directories", async () => {
      const workspacePath = path.join(tempDir, "new-workspace");
      await ensureWorkspaceStructure(workspacePath);

      const stats = await fs.stat(workspacePath);
      expect(stats.isDirectory()).toBe(true);

      const sessionsStats = await fs.stat(path.join(workspacePath, "sessions"));
      expect(sessionsStats.isDirectory()).toBe(true);

      const memoryStats = await fs.stat(path.join(workspacePath, "memory"));
      expect(memoryStats.isDirectory()).toBe(true);
    });
  });

  describe("loadWorkspaceContext", () => {
    it("loads SOUL.md into system prompt additions", async () => {
      await fs.writeFile(
        path.join(tempDir, "SOUL.md"),
        "You are a helpful assistant.",
      );

      const ctx = await loadWorkspaceContext(tempDir);

      expect(ctx.systemPromptAdditions).toContain("## SOUL.md");
      expect(ctx.systemPromptAdditions).toContain("You are a helpful assistant.");
    });

    it("loads multiple workspace files", async () => {
      await fs.writeFile(path.join(tempDir, "SOUL.md"), "Soul content");
      await fs.writeFile(path.join(tempDir, "USER.md"), "User content");
      await fs.writeFile(path.join(tempDir, "TOOLS.md"), "Tools content");

      const ctx = await loadWorkspaceContext(tempDir);

      expect(ctx.systemPromptAdditions).toContain("## SOUL.md");
      expect(ctx.systemPromptAdditions).toContain("Soul content");
      expect(ctx.systemPromptAdditions).toContain("## USER.md");
      expect(ctx.systemPromptAdditions).toContain("User content");
      expect(ctx.systemPromptAdditions).toContain("## TOOLS.md");
      expect(ctx.systemPromptAdditions).toContain("Tools content");
    });

    it("loads MEMORY.md", async () => {
      await fs.writeFile(path.join(tempDir, "MEMORY.md"), "Past conversations...");

      const ctx = await loadWorkspaceContext(tempDir);

      expect(ctx.memory).toBe("Past conversations...");
    });

    it("loads daily memory file", async () => {
      await fs.mkdir(path.join(tempDir, "memory"));
      const today = new Date().toISOString().split("T")[0];
      await fs.writeFile(
        path.join(tempDir, "memory", `${today}.md`),
        "Today's notes",
      );

      const ctx = await loadWorkspaceContext(tempDir);

      expect(ctx.memory).toContain("Today's notes");
    });

    it("combines MEMORY.md and daily memory", async () => {
      await fs.writeFile(path.join(tempDir, "MEMORY.md"), "Long-term memory");
      await fs.mkdir(path.join(tempDir, "memory"));
      const today = new Date().toISOString().split("T")[0];
      await fs.writeFile(
        path.join(tempDir, "memory", `${today}.md`),
        "Daily notes",
      );

      const ctx = await loadWorkspaceContext(tempDir);

      expect(ctx.memory).toContain("Long-term memory");
      expect(ctx.memory).toContain("Daily notes");
    });

    it("returns empty values for missing files", async () => {
      const ctx = await loadWorkspaceContext(tempDir);

      expect(ctx.systemPromptAdditions).toBe("");
      expect(ctx.memory).toBeNull();
    });
  });

  describe("buildSystemPrompt", () => {
    it("returns base prompt when no workspace", () => {
      const result = buildSystemPrompt("Base prompt", null);
      expect(result).toBe("Base prompt");
    });

    it("combines base prompt with workspace context", async () => {
      await fs.writeFile(path.join(tempDir, "SOUL.md"), "Soul");
      await fs.writeFile(path.join(tempDir, "MEMORY.md"), "Memory");

      const ctx = await loadWorkspaceContext(tempDir);
      const result = buildSystemPrompt("Base prompt", ctx);

      expect(result).toContain("Base prompt");
      expect(result).toContain("Workspace Context");
      expect(result).toContain("Soul");
      expect(result).toContain("Memory");
    });

    it("separates sections with --- dividers", async () => {
      await fs.writeFile(path.join(tempDir, "SOUL.md"), "Soul content");
      await fs.writeFile(path.join(tempDir, "MEMORY.md"), "Memory content");

      const ctx = await loadWorkspaceContext(tempDir);
      const result = buildSystemPrompt("Base prompt", ctx);

      // Sections should be separated by "---"
      const sections = result.split("\n\n---\n\n");
      expect(sections.length).toBe(3); // base + workspace context + memory
      expect(sections[0]).toBe("Base prompt");
      expect(sections[1]).toContain("# Workspace Context");
      expect(sections[2]).toContain("# Memory");
    });

    it("omits workspace section when no workspace files exist", async () => {
      const ctx = await loadWorkspaceContext(tempDir);
      const result = buildSystemPrompt("Base prompt", ctx);

      // No workspace files → systemPromptAdditions is empty, memory is null
      // Should return just the base prompt with no additions
      expect(result).toBe("Base prompt");
    });

    it("includes workspace context but omits memory when MEMORY.md is absent", async () => {
      await fs.writeFile(path.join(tempDir, "SOUL.md"), "Soul content");

      const ctx = await loadWorkspaceContext(tempDir);
      const result = buildSystemPrompt("Base prompt", ctx);

      expect(result).toContain("Workspace Context");
      expect(result).toContain("Soul content");
      expect(result).not.toContain("# Memory");
    });

    it("works with empty base prompt and workspace files", async () => {
      await fs.writeFile(path.join(tempDir, "SOUL.md"), "You are Major.");
      await fs.writeFile(path.join(tempDir, "TOOLS.md"), "Use shell for commands.");
      await fs.writeFile(path.join(tempDir, "MEMORY.md"), "Previously discussed X.");

      const ctx = await loadWorkspaceContext(tempDir);
      const result = buildSystemPrompt("", ctx);

      expect(result).toContain("You are Major.");
      expect(result).toContain("Use shell for commands.");
      expect(result).toContain("Previously discussed X.");
    });
  });

  describe("getSessionsDir", () => {
    it("returns sessions subdirectory path", () => {
      const result = getSessionsDir("/path/to/workspace");
      expect(result).toBe("/path/to/workspace/sessions");
    });
  });
});
