// src/tools/self-iteration.test.ts — Tests for createSelfIterationTools

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be before imports that use them
// ---------------------------------------------------------------------------

const mockWriteWorkspaceFile = vi.fn();
const mockAppendToMemory = vi.fn();
const mockAppendToDailyNote = vi.fn();

vi.mock("../workspace/writer.js", () => ({
  writeWorkspaceFile: (...args: unknown[]) => mockWriteWorkspaceFile(...args),
  appendToMemory: (...args: unknown[]) => mockAppendToMemory(...args),
  appendToDailyNote: (...args: unknown[]) => mockAppendToDailyNote(...args),
}));

const mockUnlink = vi.fn();
const mockReadFile = vi.fn();
const mockMkdir = vi.fn();

vi.mock("node:fs/promises", () => ({
  default: {
    unlink: (...args: unknown[]) => mockUnlink(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
  },
}));

vi.mock("../core/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import {
  createSelfIterationTools,
  ITERATE_SELF_TOOL,
  CREATE_SKILL_TOOL,
  APPEND_MEMORY_TOOL,
  DEFAULT_SELF_ITERATION_FILES,
} from "./self-iteration.js";
import type { ToolEntry } from "../core/tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  workspacePath: "/workspace",
  backup: true,
};

function getToolEntry(entries: ToolEntry[], name: string): ToolEntry {
  const entry = entries.find((e) => e.tool.name === name);
  if (!entry) throw new Error(`Tool "${name}" not found`);
  return entry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSelfIterationTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteWorkspaceFile.mockResolvedValue({ success: true });
    mockAppendToMemory.mockResolvedValue({ success: true });
    mockAppendToDailyNote.mockResolvedValue({ success: true });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockUnlink.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Factory function
  // -------------------------------------------------------------------------

  describe("factory function", () => {
    it("returns array with 3 tool entries", () => {
      const entries = createSelfIterationTools(DEFAULT_CONFIG);
      expect(entries).toHaveLength(3);
    });

    it("returns tools with correct names", () => {
      const entries = createSelfIterationTools(DEFAULT_CONFIG);
      const names = entries.map((e) => e.tool.name);
      expect(names).toEqual(["iterate_self", "create_skill", "append_memory"]);
    });

    it("each entry has a handler function", () => {
      const entries = createSelfIterationTools(DEFAULT_CONFIG);
      for (const entry of entries) {
        expect(typeof entry.handler).toBe("function");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Tool metadata
  // -------------------------------------------------------------------------

  describe("tool metadata", () => {
    it("ITERATE_SELF_TOOL has correct name", () => {
      expect(ITERATE_SELF_TOOL.name).toBe("iterate_self");
    });

    it("CREATE_SKILL_TOOL has correct name", () => {
      expect(CREATE_SKILL_TOOL.name).toBe("create_skill");
    });

    it("APPEND_MEMORY_TOOL has correct name", () => {
      expect(APPEND_MEMORY_TOOL.name).toBe("append_memory");
    });

    it("exports DEFAULT_SELF_ITERATION_FILES", () => {
      expect(DEFAULT_SELF_ITERATION_FILES).toContain("SOUL.md");
      expect(DEFAULT_SELF_ITERATION_FILES).toContain("MEMORY.md");
      expect(DEFAULT_SELF_ITERATION_FILES).toContain("BOOTSTRAP.md");
    });
  });

  // -------------------------------------------------------------------------
  // iterate_self tool
  // -------------------------------------------------------------------------

  describe("iterate_self", () => {
    function getHandler() {
      return getToolEntry(createSelfIterationTools(DEFAULT_CONFIG), "iterate_self").handler;
    }

    // -- replace action --

    describe("replace action", () => {
      it("calls writeWorkspaceFile with file content and options", async () => {
        const handler = getHandler();
        await handler({ file: "SOUL.md", action: "replace", content: "# New Soul" });

        expect(mockWriteWorkspaceFile).toHaveBeenCalledWith(
          "SOUL.md",
          "# New Soul",
          expect.objectContaining({
            workspacePath: "/workspace",
            backup: true,
          }),
        );
      });

      it("returns the write result as JSON", async () => {
        mockWriteWorkspaceFile.mockResolvedValue({
          success: true,
          backupPath: "/workspace/SOUL.md.bak",
        });

        const handler = getHandler();
        const raw = await handler({ file: "SOUL.md", action: "replace", content: "new" });
        const result = JSON.parse(raw);

        expect(result.success).toBe(true);
        expect(result.backupPath).toBe("/workspace/SOUL.md.bak");
      });

      it("returns error when content is missing", async () => {
        const handler = getHandler();
        const raw = await handler({ file: "SOUL.md", action: "replace" });
        const result = JSON.parse(raw);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Content is required");
        expect(result.error).toContain("replace");
      });

      it("uses custom allowedFiles from config", async () => {
        const config = { workspacePath: "/ws", allowedFiles: ["SOUL.md"] };
        const handler = getToolEntry(createSelfIterationTools(config), "iterate_self").handler;

        await handler({ file: "SOUL.md", action: "replace", content: "x" });

        expect(mockWriteWorkspaceFile).toHaveBeenCalledWith(
          "SOUL.md",
          "x",
          expect.objectContaining({ allowedFiles: ["SOUL.md"] }),
        );
      });

      it("defaults backup to true when not specified", async () => {
        const config = { workspacePath: "/ws" };
        const handler = getToolEntry(createSelfIterationTools(config), "iterate_self").handler;

        await handler({ file: "SOUL.md", action: "replace", content: "x" });

        expect(mockWriteWorkspaceFile).toHaveBeenCalledWith(
          "SOUL.md",
          "x",
          expect.objectContaining({ backup: true }),
        );
      });
    });

    // -- append action --

    describe("append action", () => {
      it("reads existing content and appends new content", async () => {
        mockReadFile.mockResolvedValue("existing content");

        const handler = getHandler();
        await handler({ file: "SOUL.md", action: "append", content: "appended" });

        expect(mockReadFile).toHaveBeenCalledWith(
          "/workspace/SOUL.md",
          "utf-8",
        );
        expect(mockWriteWorkspaceFile).toHaveBeenCalledWith(
          "SOUL.md",
          "existing content\nappended",
          expect.any(Object),
        );
      });

      it("creates new file when file does not exist", async () => {
        mockReadFile.mockRejectedValue(new Error("ENOENT"));

        const handler = getHandler();
        await handler({ file: "TOOLS.md", action: "append", content: "new content" });

        expect(mockWriteWorkspaceFile).toHaveBeenCalledWith(
          "TOOLS.md",
          "new content",
          expect.any(Object),
        );
      });

      it("returns error when content is missing", async () => {
        const handler = getHandler();
        const raw = await handler({ file: "SOUL.md", action: "append" });
        const result = JSON.parse(raw);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Content is required");
        expect(result.error).toContain("append");
      });
    });

    // -- delete action --

    describe("delete action", () => {
      it("deletes BOOTSTRAP.md successfully", async () => {
        const handler = getHandler();
        const raw = await handler({ file: "BOOTSTRAP.md", action: "delete" });
        const result = JSON.parse(raw);

        expect(result.success).toBe(true);
        expect(result.message).toContain("BOOTSTRAP.md deleted");
        expect(mockUnlink).toHaveBeenCalledWith("/workspace/BOOTSTRAP.md");
      });

      it("rejects deletion of non-BOOTSTRAP.md files", async () => {
        const handler = getHandler();
        const raw = await handler({ file: "SOUL.md", action: "delete" });
        const result = JSON.parse(raw);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Only BOOTSTRAP.md");
        expect(mockUnlink).not.toHaveBeenCalled();
      });

      it("returns error when unlink fails", async () => {
        mockUnlink.mockRejectedValue(new Error("ENOENT: no such file"));

        const handler = getHandler();
        const raw = await handler({ file: "BOOTSTRAP.md", action: "delete" });
        const result = JSON.parse(raw);

        expect(result.success).toBe(false);
        expect(result.error).toContain("ENOENT");
      });

      it("handles non-Error throw during delete", async () => {
        mockUnlink.mockRejectedValue("string error");

        const handler = getHandler();
        const raw = await handler({ file: "BOOTSTRAP.md", action: "delete" });
        const result = JSON.parse(raw);

        expect(result.success).toBe(false);
        expect(result.error).toBe("string error");
      });
    });

    // -- patch action --

    describe("patch action", () => {
      it("returns not implemented error", async () => {
        const handler = getHandler();
        const raw = await handler({ file: "SOUL.md", action: "patch", content: "diff" });
        const result = JSON.parse(raw);

        expect(result.success).toBe(false);
        expect(result.error).toContain("not yet implemented");
      });
    });
  });

  // -------------------------------------------------------------------------
  // create_skill tool
  // -------------------------------------------------------------------------

  describe("create_skill", () => {
    function getHandler() {
      return getToolEntry(createSelfIterationTools(DEFAULT_CONFIG), "create_skill").handler;
    }

    it("creates skill directory and writes SKILL.md", async () => {
      const handler = getHandler();
      const content = "---\nname: git-helper\ndescription: Git helper\n---\n\nInstructions.";

      const raw = await handler({ name: "git-helper", description: "Git helper", content });
      const result = JSON.parse(raw);

      expect(result.success).toBe(true);
      expect(result.path).toBe("skills/git-helper/SKILL.md");
      expect(result.message).toContain("git-helper");

      expect(mockMkdir).toHaveBeenCalledWith(
        "/workspace/skills/git-helper",
        { recursive: true },
      );
      expect(mockWriteWorkspaceFile).toHaveBeenCalledWith(
        "skills/git-helper/SKILL.md",
        content,
        expect.any(Object),
      );
    });

    it("returns error for uppercase skill name", async () => {
      const handler = getHandler();
      const raw = await handler({
        name: "GitHelper",
        description: "desc",
        content: "---\nfoo\n---",
      });
      const result = JSON.parse(raw);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid skill name");
      expect(mockMkdir).not.toHaveBeenCalled();
    });

    it("returns error for skill name with special characters", async () => {
      const handler = getHandler();
      const raw = await handler({
        name: "my_skill!",
        description: "desc",
        content: "---\nfoo\n---",
      });
      const result = JSON.parse(raw);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid skill name");
    });

    it("returns error for skill name starting with a number", async () => {
      const handler = getHandler();
      const raw = await handler({
        name: "1skill",
        description: "desc",
        content: "---\nfoo\n---",
      });
      const result = JSON.parse(raw);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid skill name");
    });

    it("accepts valid lowercase hyphenated names", async () => {
      const handler = getHandler();
      const raw = await handler({
        name: "code-review",
        description: "Review code",
        content: "---\nname: code-review\n---",
      });
      const result = JSON.parse(raw);

      expect(result.success).toBe(true);
    });

    it("accepts names with digits after first letter", async () => {
      const handler = getHandler();
      const raw = await handler({
        name: "v2-helper",
        description: "desc",
        content: "---\nfoo\n---",
      });
      const result = JSON.parse(raw);

      expect(result.success).toBe(true);
    });

    it("returns error when content is missing frontmatter", async () => {
      const handler = getHandler();
      const raw = await handler({
        name: "my-skill",
        description: "desc",
        content: "# No frontmatter here",
      });
      const result = JSON.parse(raw);

      expect(result.success).toBe(false);
      expect(result.error).toContain("frontmatter");
    });

    it("returns writeWorkspaceFile failure result", async () => {
      mockWriteWorkspaceFile.mockResolvedValue({
        success: false,
        error: "File not in allowed list",
      });

      const handler = getHandler();
      const raw = await handler({
        name: "my-skill",
        description: "desc",
        content: "---\nfoo\n---",
      });
      const result = JSON.parse(raw);

      expect(result.success).toBe(false);
      expect(result.error).toBe("File not in allowed list");
    });

    it("catches mkdir error and returns failure", async () => {
      mockMkdir.mockRejectedValue(new Error("EACCES: permission denied"));

      const handler = getHandler();
      const raw = await handler({
        name: "my-skill",
        description: "desc",
        content: "---\nfoo\n---",
      });
      const result = JSON.parse(raw);

      expect(result.success).toBe(false);
      expect(result.error).toContain("EACCES");
    });
  });

  // -------------------------------------------------------------------------
  // append_memory tool
  // -------------------------------------------------------------------------

  describe("append_memory", () => {
    function getHandler() {
      return getToolEntry(createSelfIterationTools(DEFAULT_CONFIG), "append_memory").handler;
    }

    it("appends to MEMORY.md when target is 'memory'", async () => {
      const handler = getHandler();
      const raw = await handler({ content: "Remember this", target: "memory" });
      const result = JSON.parse(raw);

      expect(result.success).toBe(true);
      expect(mockAppendToMemory).toHaveBeenCalledWith(
        "Remember this",
        expect.objectContaining({ workspacePath: "/workspace" }),
      );
      expect(mockAppendToDailyNote).not.toHaveBeenCalled();
    });

    it("appends to daily note when target is 'daily'", async () => {
      const handler = getHandler();
      const raw = await handler({ content: "Daily note", target: "daily" });
      const result = JSON.parse(raw);

      expect(result.success).toBe(true);
      expect(mockAppendToDailyNote).toHaveBeenCalledWith(
        "Daily note",
        expect.objectContaining({ workspacePath: "/workspace" }),
      );
      expect(mockAppendToMemory).not.toHaveBeenCalled();
    });

    it("defaults to 'daily' when no target specified", async () => {
      const handler = getHandler();
      await handler({ content: "No target specified" });

      expect(mockAppendToDailyNote).toHaveBeenCalledWith(
        "No target specified",
        expect.any(Object),
      );
      expect(mockAppendToMemory).not.toHaveBeenCalled();
    });

    it("passes workspace options to appendToMemory", async () => {
      const config = {
        workspacePath: "/ws",
        allowedFiles: ["MEMORY.md"],
        backup: false,
      };
      const handler = getToolEntry(createSelfIterationTools(config), "append_memory").handler;
      await handler({ content: "test", target: "memory" });

      expect(mockAppendToMemory).toHaveBeenCalledWith("test", {
        workspacePath: "/ws",
        allowedFiles: ["MEMORY.md"],
        backup: false,
      });
    });

    it("passes workspace options to appendToDailyNote", async () => {
      const config = {
        workspacePath: "/ws",
        allowedFiles: ["memory/*.md"],
        backup: true,
      };
      const handler = getToolEntry(createSelfIterationTools(config), "append_memory").handler;
      await handler({ content: "test", target: "daily" });

      expect(mockAppendToDailyNote).toHaveBeenCalledWith("test", {
        workspacePath: "/ws",
        allowedFiles: ["memory/*.md"],
        backup: true,
      });
    });

    it("uses default allowed files when config omits them", async () => {
      const handler = getHandler();
      await handler({ content: "test", target: "memory" });

      expect(mockAppendToMemory).toHaveBeenCalledWith(
        "test",
        expect.objectContaining({
          allowedFiles: DEFAULT_SELF_ITERATION_FILES,
        }),
      );
    });
  });
});
