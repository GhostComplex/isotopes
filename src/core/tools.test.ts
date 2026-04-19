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
  createReadFileTool,
  createWriteFileTool,
  createEditFileTool,
  createListDirTool,
  createWorkspaceTools,
  createWorkspaceToolsWithGuards,
  resolveToolGuards,
  applyToolPolicy,
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

    it("reads file with offset", async () => {
      const testFile = path.join(tempDir, "lines.txt");
      await fs.writeFile(testFile, "line0\nline1\nline2\nline3\nline4");

      const { handler } = createReadFileTool({ basePath: tempDir });
      const result = await handler({ path: "lines.txt", offset: 2 });

      expect(result).toContain("line2");
      expect(result).toContain("line3");
      expect(result).toContain("line4");
      expect(result).not.toContain("line0");
      expect(result).not.toContain("line1\n");
    });

    it("reads file with limit", async () => {
      const testFile = path.join(tempDir, "lines.txt");
      await fs.writeFile(testFile, "line0\nline1\nline2\nline3\nline4");

      const { handler } = createReadFileTool({ basePath: tempDir });
      const result = await handler({ path: "lines.txt", limit: 2 });

      expect(result).toContain("line0");
      expect(result).toContain("line1");
      expect(result).toContain("[truncated]");
      expect(result).toContain("[lines 1-2 of 5]");
    });

    it("reads file with offset and limit", async () => {
      const testFile = path.join(tempDir, "lines.txt");
      await fs.writeFile(testFile, "line0\nline1\nline2\nline3\nline4");

      const { handler } = createReadFileTool({ basePath: tempDir });
      const result = await handler({ path: "lines.txt", offset: 1, limit: 2 });

      expect(result).toContain("[lines 2-3 of 5]");
      expect(result).toContain("line1");
      expect(result).toContain("line2");
      expect(result).toContain("[truncated]");
    });

    it("truncates large files to 2000 lines by default", async () => {
      const testFile = path.join(tempDir, "big.txt");
      const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
      await fs.writeFile(testFile, lines.join("\n"));

      const { handler } = createReadFileTool({ basePath: tempDir, maxReadSize: 1024 * 1024 });
      const result = await handler({ path: "big.txt" });

      expect(result).toContain("[lines 1-2000 of 3000]");
      expect(result).toContain("[truncated]");
      expect(result).toContain("line 0");
      expect(result).toContain("line 1999");
      expect(result).not.toContain("line 2000\n");
    });

    it("returns error for files exceeding maxReadSize without offset/limit", async () => {
      const testFile = path.join(tempDir, "huge.txt");
      // Write more than default 50KB
      await fs.writeFile(testFile, "x".repeat(60 * 1024));

      const { handler } = createReadFileTool({ basePath: tempDir });
      const result = await handler({ path: "huge.txt" });

      expect(result).toContain("[error]");
      expect(result).toContain("File too large");
      expect(result).toContain("offset and limit");
    });

    it("reads image file as base64 JSON", async () => {
      const testFile = path.join(tempDir, "test.png");
      const fakeImageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
      await fs.writeFile(testFile, fakeImageData);

      const { handler } = createReadFileTool({ basePath: tempDir });
      const result = await handler({ path: "test.png" });
      const parsed = JSON.parse(result);

      expect(parsed.type).toBe("image");
      expect(parsed.encoding).toBe("base64");
      expect(parsed.mime_type).toBe("image/png");
      expect(parsed.data).toBe(fakeImageData.toString("base64"));
    });

    it("reads jpg image with correct mime type", async () => {
      const testFile = path.join(tempDir, "photo.jpg");
      await fs.writeFile(testFile, Buffer.from([0xff, 0xd8, 0xff]));

      const { handler } = createReadFileTool({ basePath: tempDir });
      const result = await handler({ path: "photo.jpg" });
      const parsed = JSON.parse(result);

      expect(parsed.mime_type).toBe("image/jpeg");
    });

    it("reads svg image with correct mime type", async () => {
      const testFile = path.join(tempDir, "icon.svg");
      await fs.writeFile(testFile, "<svg></svg>");

      const { handler } = createReadFileTool({ basePath: tempDir });
      const result = await handler({ path: "icon.svg" });
      const parsed = JSON.parse(result);

      expect(parsed.mime_type).toBe("image/svg+xml");
    });

    it("allows reading large files when offset/limit is specified", async () => {
      const testFile = path.join(tempDir, "huge-with-offset.txt");
      await fs.writeFile(testFile, "x".repeat(60 * 1024));

      const { handler } = createReadFileTool({ basePath: tempDir });
      // Should not error — offset/limit bypasses the size check
      const result = await handler({ path: "huge-with-offset.txt", offset: 0, limit: 10 });

      expect(result).not.toContain("[error]");
      expect(result).toContain("[lines");
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

  describe("createEditFileTool", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-test-"));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("replaces matching text", async () => {
      const testFile = path.join(tempDir, "test.txt");
      await fs.writeFile(testFile, "hello world");

      const { handler } = createEditFileTool({ basePath: tempDir });
      const result = await handler({ path: "test.txt", old_text: "hello", new_text: "goodbye" });

      const parsed = JSON.parse(result);
      expect(parsed).toEqual({ success: true, matches: 1 });
      const content = await fs.readFile(testFile, "utf-8");
      expect(content).toBe("goodbye world");
    });

    it("returns error for missing file", async () => {
      const { handler } = createEditFileTool({ basePath: tempDir });
      const result = await handler({ path: "nonexistent.txt", old_text: "hello", new_text: "goodbye" });

      expect(result).toContain("[error]");
      expect(result).toContain("not found");
    });

    it("returns error when old_text is not found", async () => {
      const testFile = path.join(tempDir, "test.txt");
      await fs.writeFile(testFile, "hello world");

      const { handler } = createEditFileTool({ basePath: tempDir });
      const result = await handler({ path: "test.txt", old_text: "missing", new_text: "replaced" });

      expect(result).toContain("[error]");
      expect(result).toContain("old_text not found");
    });

    it("returns error when old_text is found multiple times without expected_count", async () => {
      const testFile = path.join(tempDir, "test.txt");
      await fs.writeFile(testFile, "aaa bbb aaa");

      const { handler } = createEditFileTool({ basePath: tempDir });
      const result = await handler({ path: "test.txt", old_text: "aaa", new_text: "ccc" });

      expect(result).toContain("[error]");
      expect(result).toContain("2 times");
    });

    it("replaces multiple matches when expected_count matches", async () => {
      const testFile = path.join(tempDir, "test.txt");
      await fs.writeFile(testFile, "aaa bbb aaa");

      const { handler } = createEditFileTool({ basePath: tempDir });
      const result = await handler({ path: "test.txt", old_text: "aaa", new_text: "ccc", expected_count: 2 });

      const parsed = JSON.parse(result);
      expect(parsed).toEqual({ success: true, matches: 2 });
      const content = await fs.readFile(testFile, "utf-8");
      expect(content).toBe("ccc bbb ccc");
    });

    it("returns error when expected_count does not match actual count", async () => {
      const testFile = path.join(tempDir, "test.txt");
      await fs.writeFile(testFile, "aaa bbb aaa");

      const { handler } = createEditFileTool({ basePath: tempDir });
      const result = await handler({ path: "test.txt", old_text: "aaa", new_text: "ccc", expected_count: 3 });

      expect(result).toContain("[error]");
      expect(result).toContain("Expected 3 matches but found 2");
    });

    it("returns error when old_text is empty", async () => {
      const testFile = path.join(tempDir, "test.txt");
      await fs.writeFile(testFile, "hello world");

      const { handler } = createEditFileTool({ basePath: tempDir });
      const result = await handler({ path: "test.txt", old_text: "", new_text: "replaced" });

      expect(result).toContain("[error]");
      expect(result).toContain("must not be empty");
    });

    it("returns success when old_text equals new_text", async () => {
      const testFile = path.join(tempDir, "test.txt");
      await fs.writeFile(testFile, "hello world");

      const { handler } = createEditFileTool({ basePath: tempDir });
      const result = await handler({ path: "test.txt", old_text: "hello", new_text: "hello" });

      const parsed = JSON.parse(result);
      expect(parsed).toEqual({ success: true, matches: 1 });
      const content = await fs.readFile(testFile, "utf-8");
      expect(content).toBe("hello world");
    });

    it("rejects edits that escape the workspace", async () => {
      const outsideFile = path.join(os.tmpdir(), `outside-edit-${Date.now()}.txt`);
      await fs.writeFile(outsideFile, "secret data");

      try {
        const { handler } = createEditFileTool({ basePath: tempDir });
        const result = await handler({ path: outsideFile, old_text: "secret", new_text: "public" });

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
      expect(names).toContain("edit");
      expect(names).toContain("list_dir");
      expect(names).toContain("get_current_time");
      expect(names).not.toContain("shell");
      expect(names).not.toContain("exec"); // exec is registered separately in cli.ts
    });

    it("does not include shell or exec (exec is registered in cli.ts)", () => {
      const tools = createWorkspaceToolsWithGuards("/tmp/workspace", { cli: true });
      const names = tools.map((entry) => entry.tool.name);
      expect(names).not.toContain("shell");
      expect(names).toContain("read_file");
    });

    it("routes write/read through injected fsImpl when provided", async () => {
      const calls: string[] = [];
      const fakeFs = {
        readFile: vi.fn(async () => "fake-content"),
        writeFile: vi.fn(async (_p: string, _c: string) => { calls.push("writeFile"); }),
        mkdir: vi.fn(async () => undefined),
        unlink: vi.fn(async () => undefined),
        rename: vi.fn(async () => undefined),
        stat: vi.fn(async () => ({ size: 12, isFile: () => true })),
        readdir: vi.fn(async () => []),
      };

      const tools = createWorkspaceToolsWithGuards(
        "/tmp/workspace",
        undefined,
        false,
        [],
        "auto",
        undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fakeFs as any,
      );
      const writeTool = tools.find((t) => t.tool.name === "write_file");
      expect(writeTool).toBeDefined();

      // Disable workspace constraint by passing absolute path under basePath
      // (the resolver will still call fakeFs.mkdir for the parent dir).
      await writeTool!.handler({ path: "/tmp/workspace/x.txt", content: "hello" });

      expect(fakeFs.writeFile).toHaveBeenCalled();
      expect(fakeFs.mkdir).toHaveBeenCalled();
      expect(calls).toContain("writeFile");
    });

    it("excludes file writing tools when codingMode is 'subagent'", () => {
      const tools = createWorkspaceToolsWithGuards(
        "/tmp/workspace",
        { cli: true },
        true, // subagentEnabled
        [], // allowedWorkspaces
        "subagent",
      );
      const names = tools.map((entry) => entry.tool.name);

      // Should exclude write_file and edit
      expect(names).not.toContain("write_file");
      expect(names).not.toContain("edit");

      // Should still have spawn_subagent, read_file (exec is in cli.ts)
      expect(names).toContain("spawn_subagent");
      expect(names).toContain("read_file");
    });

    it("includes file writing tools when codingMode is 'direct' or 'auto'", () => {
      const directTools = createWorkspaceToolsWithGuards(
        "/tmp/workspace",
        { cli: true },
        false,
        [],
        "direct",
      );
      const autoTools = createWorkspaceToolsWithGuards(
        "/tmp/workspace",
        { cli: true },
        false,
        [],
        "auto",
      );

      expect(directTools.map((e) => e.tool.name)).toContain("write_file");
      expect(directTools.map((e) => e.tool.name)).toContain("edit");
      expect(autoTools.map((e) => e.tool.name)).toContain("write_file");
      expect(autoTools.map((e) => e.tool.name)).toContain("edit");
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
      expect(prompt).toContain("restricted to the workspace: /tmp/workspace");
      expect(prompt).toContain("exec command execution is enabled");
    });
  });
});

describe("applyToolPolicy", () => {
  function makeTools(...names: string[]) {
    return names.map((name) => ({
      tool: { name, description: `${name} tool`, parameters: {} } as Tool,
      handler: (async () => "") as ToolHandler,
    }));
  }

  it("returns all tools when no policy is provided", () => {
    const tools = makeTools("a", "b", "c");
    const result = applyToolPolicy(tools, undefined);
    expect(result.map((t) => t.tool.name)).toEqual(["a", "b", "c"]);
  });

  it("returns all tools when policy has neither allow nor deny", () => {
    const tools = makeTools("a", "b", "c");
    const result = applyToolPolicy(tools, {});
    expect(result.map((t) => t.tool.name)).toEqual(["a", "b", "c"]);
  });

  it("filters to only allowed tools when allow is set", () => {
    const tools = makeTools("read_file", "write_file", "shell", "get_current_time");
    const result = applyToolPolicy(tools, { allow: ["read_file", "get_current_time"] });
    expect(result.map((t) => t.tool.name)).toEqual(["read_file", "get_current_time"]);
  });

  it("removes denied tools when deny is set", () => {
    const tools = makeTools("read_file", "write_file", "shell", "get_current_time");
    const result = applyToolPolicy(tools, { deny: ["shell", "write_file"] });
    expect(result.map((t) => t.tool.name)).toEqual(["read_file", "get_current_time"]);
  });

  it("deny takes precedence over allow", () => {
    const tools = makeTools("read_file", "write_file", "shell");
    const result = applyToolPolicy(tools, {
      allow: ["read_file", "write_file", "shell"],
      deny: ["shell"],
    });
    expect(result.map((t) => t.tool.name)).toEqual(["read_file", "write_file"]);
  });

  it("returns empty array when all tools are denied", () => {
    const tools = makeTools("a", "b");
    const result = applyToolPolicy(tools, { deny: ["a", "b"] });
    expect(result).toEqual([]);
  });

  it("returns empty array when allow is empty", () => {
    const tools = makeTools("a", "b");
    const result = applyToolPolicy(tools, { allow: [] });
    expect(result).toEqual([]);
  });

  it("ignores deny entries that do not match any tool", () => {
    const tools = makeTools("a", "b");
    const result = applyToolPolicy(tools, { deny: ["nonexistent"] });
    expect(result.map((t) => t.tool.name)).toEqual(["a", "b"]);
  });

  it("ignores allow entries that do not match any tool", () => {
    const tools = makeTools("a", "b");
    const result = applyToolPolicy(tools, { allow: ["a", "nonexistent"] });
    expect(result.map((t) => t.tool.name)).toEqual(["a"]);
  });
});
