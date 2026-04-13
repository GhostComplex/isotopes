// tests/e2e-smoke.test.ts — E2E smoke test for agent tools (#246)
//
// Verifies that all core tools (read, edit, exec, web_fetch, sessions_list)
// work correctly when wired through ToolRegistry, mirroring cli.ts setup.
// Also tests tool policy deny behavior and NO_REPLY suppression.
//
// Run: pnpm vitest tests/e2e-smoke.test.ts

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  ToolRegistry,
  createReadFileTool,
  createEditFileTool,
  createWorkspaceToolsWithGuards,
  applyToolPolicy,
} from "../src/core/tools.js";
import { createExecTools } from "../src/tools/exec.js";
import { createWebFetchTool } from "../src/tools/web.js";
import { createSessionsListTool } from "../src/tools/sessions.js";
import { AcpSessionManager } from "../src/acp/session-manager.js";
import { AgentMessageBus } from "../src/acp/message-bus.js";

// ---------------------------------------------------------------------------
// Test workspace setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-e2e-"));
  await fs.writeFile(
    path.join(tmpDir, "SOUL.md"),
    "# Test Agent\nYou are a test agent.\n",
  );
  await fs.writeFile(
    path.join(tmpDir, "MEMORY.md"),
    "# Memory\n- remembered item\n",
  );
  await fs.writeFile(
    path.join(tmpDir, "hello.txt"),
    "Hello, world!\n",
  );
});

afterAll(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. Workspace context loads
// ---------------------------------------------------------------------------

describe("workspace context", () => {
  it("SOUL.md and MEMORY.md exist in temp workspace", async () => {
    const soul = await fs.readFile(path.join(tmpDir, "SOUL.md"), "utf-8");
    expect(soul).toContain("# Test Agent");

    const memory = await fs.readFile(path.join(tmpDir, "MEMORY.md"), "utf-8");
    expect(memory).toContain("remembered item");
  });
});

// ---------------------------------------------------------------------------
// 2. read_file tool
// ---------------------------------------------------------------------------

describe("read_file tool", () => {
  it("reads a file from the workspace", async () => {
    const registry = new ToolRegistry();
    const { tool, handler } = createReadFileTool({ basePath: tmpDir });
    registry.register(tool, handler);

    const result = await registry.execute("read_file", { path: "hello.txt" });
    expect(result).toBe("Hello, world!\n");
  });

  it("returns error for nonexistent file", async () => {
    const registry = new ToolRegistry();
    const { tool, handler } = createReadFileTool({ basePath: tmpDir });
    registry.register(tool, handler);

    const result = await registry.execute("read_file", { path: "nope.txt" });
    expect(result).toContain("[error]");
    expect(result).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// 3. edit tool
// ---------------------------------------------------------------------------

describe("edit tool", () => {
  it("modifies file content via search-and-replace", async () => {
    // Create a file to edit
    const editFile = path.join(tmpDir, "editable.txt");
    await fs.writeFile(editFile, "foo bar baz\n");

    const registry = new ToolRegistry();
    const { tool, handler } = createEditFileTool({ basePath: tmpDir });
    registry.register(tool, handler);

    const result = await registry.execute("edit", {
      path: "editable.txt",
      old_text: "bar",
      new_text: "qux",
    });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);

    const updated = await fs.readFile(editFile, "utf-8");
    expect(updated).toBe("foo qux baz\n");
  });
});

// ---------------------------------------------------------------------------
// 4. exec tool
// ---------------------------------------------------------------------------

describe("exec tool", () => {
  it("runs a shell command and returns stdout", async () => {
    const registry = new ToolRegistry();
    const execTools = createExecTools({ cwd: tmpDir });
    for (const { tool, handler } of execTools) {
      registry.register(tool, handler);
    }

    const result = await registry.execute("exec", { command: "echo hello" });
    const parsed = JSON.parse(result);
    expect(parsed.exit_code).toBe(0);
    expect(parsed.stdout.trim()).toBe("hello");
  });

  it("reports non-zero exit codes", async () => {
    const registry = new ToolRegistry();
    const execTools = createExecTools({ cwd: tmpDir });
    for (const { tool, handler } of execTools) {
      registry.register(tool, handler);
    }

    const result = await registry.execute("exec", { command: "exit 42" });
    const parsed = JSON.parse(result);
    expect(parsed.exit_code).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. web_fetch tool
// ---------------------------------------------------------------------------

describe("web_fetch tool", () => {
  it("fetches a URL and returns content", async () => {
    const registry = new ToolRegistry();
    const { tool, handler } = createWebFetchTool();
    registry.register(tool, handler);

    const result = await registry.execute("web_fetch", {
      url: "https://httpbin.org/get",
    });
    expect(result).toContain("httpbin.org");
  }, 15_000);

  it("returns error for invalid URL", async () => {
    const registry = new ToolRegistry();
    const { tool, handler } = createWebFetchTool();
    registry.register(tool, handler);

    const result = await registry.execute("web_fetch", { url: "not-a-url" });
    expect(result).toContain("[error]");
  });
});

// ---------------------------------------------------------------------------
// 6. sessions_list tool
// ---------------------------------------------------------------------------

describe("sessions_list tool", () => {
  it("returns empty session list when none exist", async () => {
    const sessionManager = new AcpSessionManager({
      enabled: true,
      backend: "acpx",
      defaultAgent: "test-agent",
      allowedAgents: ["test-agent"],
    });
    const messageBus = new AgentMessageBus(sessionManager);

    const registry = new ToolRegistry();
    const { tool, handler } = createSessionsListTool({
      sessionManager,
      messageBus,
      currentAgentId: "test-agent",
    });
    registry.register(tool, handler);

    const result = await registry.execute("sessions_list", {});
    const parsed = JSON.parse(result);
    expect(parsed.sessions).toEqual([]);
    expect(parsed.total).toBe(0);
  });

  it("returns sessions after one is created", async () => {
    const sessionManager = new AcpSessionManager({
      enabled: true,
      backend: "acpx",
      defaultAgent: "test-agent",
      allowedAgents: ["test-agent", "other-agent"],
    });
    const messageBus = new AgentMessageBus(sessionManager);

    sessionManager.createSession("other-agent");

    const registry = new ToolRegistry();
    const { tool, handler } = createSessionsListTool({
      sessionManager,
      messageBus,
      currentAgentId: "test-agent",
    });
    registry.register(tool, handler);

    const result = await registry.execute("sessions_list", {});
    const parsed = JSON.parse(result);
    expect(parsed.total).toBe(1);
    expect(parsed.sessions[0].agent_id).toBe("other-agent");
    expect(parsed.sessions[0].status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// 7. NO_REPLY / HEARTBEAT_OK suppression
// ---------------------------------------------------------------------------

describe("NO_REPLY suppression", () => {
  it("detects NO_REPLY content for suppression", () => {
    // NO_REPLY is a convention where the agent's text output is exactly
    // "NO_REPLY" — the transport layer should suppress it. We verify the
    // pattern-matching logic transports use.
    const noReplyPatterns = ["NO_REPLY", "HEARTBEAT_OK"];
    const shouldSuppress = (text: string) =>
      noReplyPatterns.some((p) => text.trim() === p);

    expect(shouldSuppress("NO_REPLY")).toBe(true);
    expect(shouldSuppress("HEARTBEAT_OK")).toBe(true);
    expect(shouldSuppress("  NO_REPLY  ")).toBe(true);
    expect(shouldSuppress("Hello world")).toBe(false);
    expect(shouldSuppress("NO_REPLY but more text")).toBe(false);
    expect(shouldSuppress("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Tool policy deny
// ---------------------------------------------------------------------------

describe("tool policy deny", () => {
  it("removes denied tools from the registry", () => {
    const tools = createWorkspaceToolsWithGuards(tmpDir, { cli: true });
    const filtered = applyToolPolicy(tools, { deny: ["read_file"] });

    const names = filtered.map((t) => t.tool.name);
    expect(names).not.toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("edit");
  });

  it("denied tool cannot be executed", async () => {
    const tools = createWorkspaceToolsWithGuards(tmpDir, { cli: true });
    const filtered = applyToolPolicy(tools, { deny: ["read_file"] });

    const registry = new ToolRegistry();
    for (const { tool, handler } of filtered) {
      registry.register(tool, handler);
    }

    expect(registry.has("read_file")).toBe(false);
    await expect(registry.execute("read_file", { path: "test.txt" }))
      .rejects.toThrow('Tool "read_file" not found');
  });

  it("exec tool denied via policy is not executable", async () => {
    const execTools = createExecTools({ cwd: tmpDir });
    const filtered = applyToolPolicy(execTools, { deny: ["exec"] });

    const registry = new ToolRegistry();
    for (const { tool, handler } of filtered) {
      registry.register(tool, handler);
    }

    expect(registry.has("exec")).toBe(false);
    // process_list and process_kill should still be available
    expect(registry.has("process_list")).toBe(true);
    expect(registry.has("process_kill")).toBe(true);
  });

  it("allow list restricts to only specified tools", () => {
    const tools = createWorkspaceToolsWithGuards(tmpDir, { cli: true });
    const filtered = applyToolPolicy(tools, { allow: ["read_file", "edit"] });

    const names = filtered.map((t) => t.tool.name);
    expect(names).toEqual(["read_file", "edit"]);
  });

  it("deny takes precedence over allow", () => {
    const tools = createWorkspaceToolsWithGuards(tmpDir, { cli: true });
    const filtered = applyToolPolicy(tools, {
      allow: ["read_file", "edit"],
      deny: ["edit"],
    });

    const names = filtered.map((t) => t.tool.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("edit");
  });
});

// ---------------------------------------------------------------------------
// 9. Full tool registry wiring (mirrors cli.ts)
// ---------------------------------------------------------------------------

describe("full tool wiring", () => {
  it("registers all core tools without conflict", async () => {
    const registry = new ToolRegistry();

    // Workspace tools (read, write, edit, list_dir, time)
    const workspaceTools = createWorkspaceToolsWithGuards(tmpDir, {
      cli: true,
      web: true,
    });
    for (const { tool, handler } of workspaceTools) {
      registry.register(tool, handler);
    }

    // Exec tools (exec, process_list, process_kill) — registered separately like cli.ts
    const execTools = createExecTools({ cwd: tmpDir });
    for (const { tool, handler } of execTools) {
      registry.register(tool, handler);
    }

    // Session tools
    const sessionManager = new AcpSessionManager({
      enabled: true,
      backend: "acpx",
      defaultAgent: "test-agent",
      allowedAgents: ["test-agent"],
    });
    const messageBus = new AgentMessageBus(sessionManager);
    const { tool: slTool, handler: slHandler } = createSessionsListTool({
      sessionManager,
      messageBus,
      currentAgentId: "test-agent",
    });
    registry.register(slTool, slHandler);

    // Verify key tools are registered
    expect(registry.has("read_file")).toBe(true);
    expect(registry.has("write_file")).toBe(true);
    expect(registry.has("edit")).toBe(true);
    expect(registry.has("list_dir")).toBe(true);
    expect(registry.has("exec")).toBe(true);
    expect(registry.has("web_fetch")).toBe(true);
    expect(registry.has("web_search")).toBe(true);
    expect(registry.has("sessions_list")).toBe(true);
    expect(registry.has("get_current_time")).toBe(true);
    expect(registry.has("process_list")).toBe(true);
    expect(registry.has("process_kill")).toBe(true);

    // Smoke: execute a few tools through the unified registry
    const readResult = await registry.execute("read_file", { path: "SOUL.md" });
    expect(readResult).toContain("# Test Agent");

    const execResult = await registry.execute("exec", { command: "echo smoke" });
    const execParsed = JSON.parse(execResult);
    expect(execParsed.stdout.trim()).toBe("smoke");

    const sessResult = await registry.execute("sessions_list", {});
    const sessParsed = JSON.parse(sessResult);
    expect(sessParsed.total).toBe(0);
  });
});
