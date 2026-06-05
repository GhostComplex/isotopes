// tests/e2e-smoke.test.ts — E2E smoke test for agent tools (#246)
//
// Verifies that core tools work when wired through createAgentTools,
// mirroring agent-init setup. Also tests tool policy.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { createBashTool } from "@mariozechner/pi-coding-agent";
import { AgentRuntime } from "../src/agent/runtime.js";
import { createAgentTools } from "../src/agent/tools/index.js";
import { createWebFetchTool } from "../src/agent/tools/web.js";

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
    const tools = createAgentTools({ workspacePath: tmpDir, agentId: "test", parentAgentId: "test", parentSessionId: "s", runtime: new AgentRuntime() });
    const result = await callTool(findTool(tools, "read"), { path: "hello.txt" });
    expect(result).toContain("Hello, world!");
  });
});

describe("edit tool (SDK)", () => {
  it("modifies file content via search-and-replace", async () => {
    const editFile = path.join(tmpDir, "editable.txt");
    await fs.writeFile(editFile, "foo bar baz\n");

    const tools = createAgentTools({ workspacePath: tmpDir, agentId: "test", parentAgentId: "test", parentSessionId: "s", runtime: new AgentRuntime() });
    await callTool(findTool(tools, "edit"), {
      path: editFile,
      edits: [{ oldText: "bar", newText: "qux" }],
    });
    const updated = await fs.readFile(editFile, "utf-8");
    expect(updated).toBe("foo qux baz\n");
  });
});

describe("bash tool (pi)", () => {
  it("runs a shell command and returns stdout", async () => {
    const tool = createBashTool(tmpDir) as AgentTool;
    const result = await callTool(tool, { command: "echo hello" });
    expect(result).toMatch(/hello/);
  });

  it("rejects on non-zero exit (pi convention)", async () => {
    const tool = createBashTool(tmpDir) as AgentTool;
    await expect(tool.execute("test-call", { command: "exit 42" } as never))
      .rejects.toThrow(/exited with code 42/);
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

describe("full tool wiring", () => {
  it("registers all core tools without conflict", async () => {
    const all = createAgentTools({
      workspacePath: tmpDir,
      agentId: "test",
      parentAgentId: "test",
      parentSessionId: "s",
      runtime: new AgentRuntime(),
    });
    const names = new Set(all.map((t) => t.name));

    expect(names.has("read")).toBe(true);
    expect(names.has("write")).toBe(true);
    expect(names.has("edit")).toBe(true);
    expect(names.has("ls")).toBe(true);
    expect(names.has("bash")).toBe(true);
    expect(names.has("web_fetch")).toBe(true);
    expect(names.has("get_current_time")).toBe(true);

    // Smoke: execute a couple of tools end-to-end
    const readResult = await callTool(findTool(all, "read"), { path: "SOUL.md" });
    expect(readResult).toContain("# Test Agent");

    const bashResult = await callTool(findTool(all, "bash"), { command: "echo smoke" });
    expect(bashResult).toMatch(/smoke/);
  });
});
