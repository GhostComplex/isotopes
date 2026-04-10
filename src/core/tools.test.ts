// src/core/tools.test.ts — Unit tests for ToolRegistry

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  ToolRegistry,
  buildToolGuardPrompt,
  createEchoTool,
  createTimeTool,
  createShellTool,
  createReadFileTool,
  createWriteFileTool,
  createListDirTool,
  createWorkspaceTools,
  createWorkspaceToolsWithGuards,
  resolveToolGuards,
  type ToolHandler,
} from "./tools.js";
import type { Tool } from "./types.js";

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe("register", () => {
    it("registers a tool", () => {
      const tool: Tool = {
        name: "test",
        description: "Test tool",
        parameters: {},
      };
      const handler: ToolHandler = async () => "result";

      registry.register(tool, handler);

      expect(registry.has("test")).toBe(true);
    });

    it("throws on duplicate registration", () => {
      const tool: Tool = {
        name: "test",
        description: "Test tool",
        parameters: {},
      };
      const handler: ToolHandler = async () => "result";

      registry.register(tool, handler);

      expect(() => registry.register(tool, handler)).toThrow(
        'Tool "test" already registered',
      );
    });
  });

  describe("get", () => {
    it("returns registered tool entry", () => {
      const tool: Tool = {
        name: "test",
        description: "Test tool",
        parameters: { foo: "bar" },
      };
      const handler: ToolHandler = async () => "result";

      registry.register(tool, handler);
      const entry = registry.get("test");

      expect(entry?.tool).toEqual(tool);
      expect(entry?.handler).toBe(handler);
    });

    it("returns undefined for unknown tool", () => {
      expect(registry.get("unknown")).toBeUndefined();
    });
  });

  describe("list", () => {
    it("returns all tool schemas", () => {
      const tool1: Tool = { name: "a", description: "A", parameters: {} };
      const tool2: Tool = { name: "b", description: "B", parameters: {} };

      registry.register(tool1, async () => "");
      registry.register(tool2, async () => "");

      const tools = registry.list();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name).sort()).toEqual(["a", "b"]);
    });

    it("returns empty array when no tools", () => {
      expect(registry.list()).toEqual([]);
    });
  });

  describe("execute", () => {
    it("executes tool handler with args", async () => {
      const handler = vi.fn().mockResolvedValue("executed");
      const tool: Tool = { name: "test", description: "", parameters: {} };

      registry.register(tool, handler);
      const result = await registry.execute("test", { key: "value" });

      expect(handler).toHaveBeenCalledWith({ key: "value" });
      expect(result).toBe("executed");
    });

    it("throws for unknown tool", async () => {
      await expect(registry.execute("unknown", {})).rejects.toThrow(
        'Tool "unknown" not found',
      );
    });

    it("propagates handler errors", async () => {
      const handler = vi.fn().mockRejectedValue(new Error("Handler failed"));
      const tool: Tool = { name: "test", description: "", parameters: {} };

      registry.register(tool, handler);

      await expect(registry.execute("test", {})).rejects.toThrow("Handler failed");
    });
  });

  describe("unregister", () => {
    it("removes registered tool", () => {
      const tool: Tool = { name: "test", description: "", parameters: {} };
      registry.register(tool, async () => "");

      expect(registry.unregister("test")).toBe(true);
      expect(registry.has("test")).toBe(false);
    });

    it("returns false for unknown tool", () => {
      expect(registry.unregister("unknown")).toBe(false);
    });
  });

  describe("clear", () => {
    it("removes all tools", () => {
      registry.register({ name: "a", description: "", parameters: {} }, async () => "");
      registry.register({ name: "b", description: "", parameters: {} }, async () => "");

      registry.clear();

      expect(registry.list()).toHaveLength(0);
    });
  });
});

describe("Built-in tools", () => {
  describe("createEchoTool", () => {
    it("returns tool schema and handler", () => {
      const { tool, handler } = createEchoTool();

      expect(tool.name).toBe("echo");
      expect(tool.description.toLowerCase()).toContain("echo");
      expect(handler).toBeInstanceOf(Function);
    });

    it("echoes the message", async () => {
      const { handler } = createEchoTool();
      const result = await handler({ message: "Hello world" });

      expect(result).toBe("Hello world");
    });
  });

  describe("createTimeTool", () => {
    it("returns tool schema and handler", () => {
      const { tool, handler } = createTimeTool();

      expect(tool.name).toBe("get_current_time");
      expect(handler).toBeInstanceOf(Function);
    });

    it("returns ISO time by default", async () => {
      const { handler } = createTimeTool();
      const result = await handler({});

      // Should be ISO format
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("formats time with timezone", async () => {
      const { handler } = createTimeTool();
      const result = await handler({ timezone: "America/New_York" });

      // Should be formatted (not ISO)
      expect(result).not.toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("handles invalid timezone gracefully", async () => {
      const { handler } = createTimeTool();
      const result = await handler({ timezone: "Invalid/Zone" });

      expect(result).toContain("Invalid timezone");
    });
  });

  describe("createShellTool", () => {
    it("executes command and returns output", async () => {
      const { handler } = createShellTool();
      const result = await handler({ command: "echo hello" });

      expect(result.trim()).toBe("hello");
    });

    it("respects cwd option", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shell-test-"));
      try {
        const { handler } = createShellTool({ cwd: tempDir });
        const result = await handler({ command: "pwd" });

        // macOS: /var is symlinked to /private/var
        expect(result.trim()).toContain(path.basename(tempDir));
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("returns error for failed command", async () => {
      const { handler } = createShellTool();
      const result = await handler({ command: "exit 1" });

      expect(result).toContain("[error]");
    });
  });

  describe("createReadFileTool", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-test-"));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("reads file content", async () => {
      const testFile = path.join(tempDir, "test.txt");
      await fs.writeFile(testFile, "hello world");

      const { handler } = createReadFileTool({ basePath: tempDir });
      const result = await handler({ path: "test.txt" });

      expect(result).toBe("hello world");
    });

    it("returns error for missing file", async () => {
      const { handler } = createReadFileTool({ basePath: tempDir });
      const result = await handler({ path: "nonexistent.txt" });

      expect(result).toContain("[error]");
      expect(result).toContain("not found");
    });

    it("rejects paths that escape the workspace", async () => {
      const outsideFile = path.join(os.tmpdir(), `outside-${Date.now()}.txt`);
      await fs.writeFile(outsideFile, "secret");

      try {
        const { handler } = createReadFileTool({ basePath: tempDir });
        const result = await handler({ path: outsideFile });

        expect(result).toContain("[error]");
        expect(result).toContain("Path escapes workspace");
      } finally {
        await fs.rm(outsideFile, { force: true });
      }
    });

    it("resolves relative paths against basePath even when constrainToWorkspace is false", async () => {
      const testFile = path.join(tempDir, "identity.md");
      await fs.writeFile(testFile, "workspace content");

      const { handler } = createReadFileTool({ basePath: tempDir, constrainToWorkspace: false });
      const result = await handler({ path: "identity.md" });

      expect(result).toBe("workspace content");
    });

    it("allows absolute paths outside workspace when constrainToWorkspace is false", async () => {
      const outsideFile = path.join(os.tmpdir(), `outside-allowed-${Date.now()}.txt`);
      await fs.writeFile(outsideFile, "allowed content");

      try {
        const { handler } = createReadFileTool({ basePath: tempDir, constrainToWorkspace: false });
        const result = await handler({ path: outsideFile });

        expect(result).toBe("allowed content");
      } finally {
        await fs.rm(outsideFile, { force: true });
      }
    });
  });

  describe("createWriteFileTool", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-test-"));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("writes file content", async () => {
      const { handler } = createWriteFileTool({ basePath: tempDir });
      const result = await handler({ path: "test.txt", content: "new content" });

      expect(result).toContain("Successfully wrote");
      const content = await fs.readFile(path.join(tempDir, "test.txt"), "utf-8");
      expect(content).toBe("new content");
    });

    it("creates parent directories", async () => {
      const { handler } = createWriteFileTool({ basePath: tempDir });
      await handler({ path: "nested/dir/test.txt", content: "nested" });

      const content = await fs.readFile(path.join(tempDir, "nested/dir/test.txt"), "utf-8");
      expect(content).toBe("nested");
    });

    it("rejects writes that escape the workspace", async () => {
      const outsideFile = path.join(os.tmpdir(), `outside-write-${Date.now()}.txt`);

      try {
        const { handler } = createWriteFileTool({ basePath: tempDir });
        const result = await handler({ path: outsideFile, content: "blocked" });

        expect(result).toContain("[error]");
        expect(result).toContain("Path escapes workspace");
      } finally {
        await fs.rm(outsideFile, { force: true });
      }
    });
  });

  describe("createListDirTool", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "list-test-"));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("lists directory contents", async () => {
      await fs.writeFile(path.join(tempDir, "file1.txt"), "");
      await fs.mkdir(path.join(tempDir, "subdir"));

      const { handler } = createListDirTool({ basePath: tempDir });
      const result = await handler({ path: "." });

      expect(result).toContain("file1.txt");
      expect(result).toContain("[dir]");
      expect(result).toContain("subdir");
    });

    it("returns error for missing directory", async () => {
      const { handler } = createListDirTool({ basePath: tempDir });
      const result = await handler({ path: "nonexistent" });

      expect(result).toContain("[error]");
      expect(result).toContain("not found");
    });

    it("rejects directories that escape the workspace", async () => {
      const { handler } = createListDirTool({ basePath: tempDir });
      const result = await handler({ path: os.tmpdir() });

      expect(result).toContain("[error]");
      expect(result).toContain("Path escapes workspace");
    });
  });

  describe("createWorkspaceTools", () => {
    it("creates all standard workspace tools", () => {
      const tools = createWorkspaceTools("/tmp/workspace");

      const names = tools.map((t) => t.tool.name);
      expect(names).toContain("read_file");
      expect(names).toContain("write_file");
      expect(names).toContain("list_dir");
      expect(names).toContain("get_current_time");
      expect(names).not.toContain("shell");
    });

    it("enables shell when cli guard is turned on", () => {
      const tools = createWorkspaceToolsWithGuards("/tmp/workspace", { cli: true });

      expect(tools.map((entry) => entry.tool.name)).toContain("shell");
    });
  });

  describe("resolveToolGuards", () => {
    it("defaults cli off and workspaceOnly on", () => {
      expect(resolveToolGuards()).toEqual({
        cli: false,
        fs: { workspaceOnly: true },
      });
    });

    it("supports explicit cli on and workspaceOnly off", () => {
      expect(resolveToolGuards({ cli: true, fs: { workspaceOnly: false } })).toEqual({
        cli: true,
        fs: { workspaceOnly: false },
      });
    });
  });

  describe("buildToolGuardPrompt", () => {
    it("describes the active tools and guardrails", () => {
      const prompt = buildToolGuardPrompt(
        createWorkspaceToolsWithGuards("/tmp/workspace", { cli: true }).map((entry) => entry.tool),
        { cli: true, fs: { workspaceOnly: true } },
        "/tmp/workspace",
      );

      expect(prompt).toContain("Only the following tools are available");
      expect(prompt).toContain("shell");
      expect(prompt).toContain("restricted to the workspace: /tmp/workspace");
      expect(prompt).toContain("Shell command execution is enabled");
    });
  });
});
