// tests/e2e-smoke.test.ts — E2E smoke test for agent tools (#246)
//
// Verifies that core tools work when wired through createAgentTools,
// mirroring agent-init setup. Also tests tool policy and NO_REPLY suppression.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  createAgentTools,
  applyToolPolicy,
} from "../src/legacy/core/tools.js";
import { createExecTools, ProcessRegistry } from "../src/legacy/tools/exec.js";
import { createWebFetchTool } from "../src/legacy/tools/web.js";

async function callTool(tool: AgentTool, args: unknown): Promise<string> {
  const result: AgentToolResult<unknown> = await tool.execute("test-call", args as never);
  const block = result.content.find((c) => c.type === "text") as { text: string } | undefined;
  return block?.text ?? "";
}

function findTool(tools: AgentTool[], name: string): AgentTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return t;
}

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-e2e-"));
  await fs.writeFile(path.join(tmpDir, "SOUL.md"), "# Test Agent\nYou are a test agent.\n");
  await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Memory\n- remembered item\n");
  await fs.writeFile(path.join(tmpDir, "hello.txt"), "Hello, world!\n");
});

afterAll(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("workspace context", () => {
  it("SOUL.md and MEMORY.md exist in temp workspace", async () => {
    const soul = await fs.readFile(path.join(tmpDir, "SOUL.md"), "utf-8");
    expect(soul).toContain("# Test Agent");
    const memory = await fs.readFile(path.join(tmpDir, "MEMORY.md"), "utf-8");
    expect(memory).toContain("remembered item");
  });
});

describe("read tool (SDK)", () => {
  it("reads a file from the workspace", async () => {
    const tools = createAgentTools({ workspacePath: tmpDir, agentId: "test", processRegistry: new ProcessRegistry() });
    const result = await callTool(findTool(tools, "read"), { path: "hello.txt" });
    expect(result).toContain("Hello, world!");
  });
});

describe("edit tool (SDK)", () => {
  it("modifies file content via search-and-replace", async () => {
    const editFile = path.join(tmpDir, "editable.txt");
    await fs.writeFile(editFile, "foo bar baz\n");

    const tools = createAgentTools({ workspacePath: tmpDir, agentId: "test", processRegistry: new ProcessRegistry() });
    await callTool(findTool(tools, "edit"), {
      path: editFile,
      edits: [{ oldText: "bar", newText: "qux" }],
    });
    const updated = await fs.readFile(editFile, "utf-8");
    expect(updated).toBe("foo qux baz\n");
  });
});

describe("exec tool", () => {
  it("runs a shell command and returns stdout", async () => {
    const tools = createExecTools({ cwd: tmpDir });
    const result = JSON.parse(await callTool(findTool(tools, "exec"), { command: "echo hello" }));
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("reports non-zero exit codes", async () => {
    const tools = createExecTools({ cwd: tmpDir });
    const result = JSON.parse(await callTool(findTool(tools, "exec"), { command: "exit 42" }));
    expect(result.exit_code).not.toBe(0);
  });
});

describe("web_fetch tool", () => {
  it("fetches a URL and returns content", async () => {
    const tool = createWebFetchTool();
    const result = await callTool(tool, { url: "https://httpbin.org/get" });
    expect(result).toContain("httpbin.org");
  }, 30_000);

  it("returns error for invalid URL", async () => {
    const tool = createWebFetchTool();
    const result = await callTool(tool, { url: "not-a-url" });
    expect(result).toContain("[error]");
  });
});

describe("NO_REPLY suppression", () => {
  it("detects NO_REPLY content for suppression", () => {
    const noReplyPatterns = ["NO_REPLY", "HEARTBEAT_OK"];
    const shouldSuppress = (text: string) => noReplyPatterns.some((p) => text.trim() === p);
    expect(shouldSuppress("NO_REPLY")).toBe(true);
    expect(shouldSuppress("HEARTBEAT_OK")).toBe(true);
    expect(shouldSuppress("  NO_REPLY  ")).toBe(true);
    expect(shouldSuppress("Hello world")).toBe(false);
    expect(shouldSuppress("NO_REPLY but more text")).toBe(false);
    expect(shouldSuppress("")).toBe(false);
  });
});

describe("tool policy deny", () => {
  it("removes denied tools", () => {
    const tools = createAgentTools({ workspacePath: tmpDir, agentId: "test", processRegistry: new ProcessRegistry() });
    const filtered = applyToolPolicy(tools, { deny: ["read"] });
    const names = filtered.map((t) => t.name);
    expect(names).not.toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("edit");
  });

  it("exec tool denied via policy is not present", () => {
    const execTools = createExecTools({ cwd: tmpDir });
    const filtered = applyToolPolicy(execTools, { deny: ["exec"] });
    const names = filtered.map((t) => t.name);
    expect(names).not.toContain("exec");
    expect(names).toContain("process_list");
    expect(names).toContain("process_kill");
  });

  it("allow list restricts to only specified tools", () => {
    const tools = createAgentTools({ workspacePath: tmpDir, agentId: "test", processRegistry: new ProcessRegistry() });
    const filtered = applyToolPolicy(tools, { allow: ["read", "edit"] });
    expect(filtered.map((t) => t.name).sort()).toEqual(["edit", "read"]);
  });

  it("deny takes precedence over allow", () => {
    const tools = createAgentTools({ workspacePath: tmpDir, agentId: "test", processRegistry: new ProcessRegistry() });
    const filtered = applyToolPolicy(tools, {
      allow: ["read", "edit"],
      deny: ["edit"],
    });
    const names = filtered.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).not.toContain("edit");
  });
});

describe("full tool wiring", () => {
  it("registers all core tools without conflict", async () => {
    const all = createAgentTools({
      workspacePath: tmpDir,
      agentId: "test",
      processRegistry: new ProcessRegistry(),
      settings: { web: true },
    });
    const names = new Set(all.map((t) => t.name));

    expect(names.has("read")).toBe(true);
    expect(names.has("write")).toBe(true);
    expect(names.has("edit")).toBe(true);
    expect(names.has("ls")).toBe(true);
    expect(names.has("exec")).toBe(true);
    expect(names.has("web_fetch")).toBe(true);
    expect(names.has("web_search")).toBe(true);
    expect(names.has("get_current_time")).toBe(true);
    expect(names.has("process_list")).toBe(true);
    expect(names.has("process_kill")).toBe(true);

    // Smoke: execute a couple of tools end-to-end
    const readResult = await callTool(findTool(all, "read"), { path: "SOUL.md" });
    expect(readResult).toContain("# Test Agent");

    const execResult = JSON.parse(await callTool(findTool(all, "exec"), { command: "echo smoke" }));
    expect(execResult.stdout.trim()).toBe("smoke");
  });
});
