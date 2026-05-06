import { describe, it, expect, vi } from "vitest";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

async function callTool(tool: AgentTool, args: unknown): Promise<string> {
  const result: AgentToolResult<unknown> = await tool.execute("test-call", args as never);
  const block = result.content.find((c) => c.type === "text") as { text: string } | undefined;
  return block?.text ?? "";
}

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { createExecTool, createExecTools } from "./exec.js";
import { HostExecutor } from "../host-executor.js";
import type { Executor } from "../executor.js";

function makeMockExecutor(overrides?: Partial<Executor>): Executor {
  return {
    execute: vi.fn(async () => ({
      exitCode: 0,
      stdout: Buffer.from("mocked-out"),
      stderr: Buffer.alloc(0),
    })),
    buildExecArgv: vi.fn(async (argv: string[]) => argv),
    ...overrides,
  };
}

describe("createExecTool", () => {
  it("returns a tool with correct schema", () => {
    const tool = createExecTool({ executor: makeMockExecutor() });
    expect(tool.name).toBe("exec");
    expect(tool.parameters).toBeDefined();
  });

  it("wraps command in sh -c and delegates to executor.execute", async () => {
    const executor = makeMockExecutor();
    const tool = createExecTool({ cwd: "/ws", executor });
    const result = JSON.parse(await callTool(tool, { command: "echo hi" }));

    expect(executor.execute).toHaveBeenCalledWith(
      ["sh", "-c", "echo hi"],
      { workspacePath: "/ws", timeout: expect.any(Number) },
    );
    expect(result.stdout).toBe("mocked-out");
    expect(result.exit_code).toBe(0);
  });

  it("returns error for empty command", async () => {
    const tool = createExecTool({ executor: makeMockExecutor() });
    const result = JSON.parse(await callTool(tool, { command: "" }));
    expect(result.error).toContain("must not be empty");
  });

  it("returns timeout JSON when executor reports timed out", async () => {
    const executor = makeMockExecutor({
      execute: vi.fn(async () => { throw new Error("Sandbox execution timed out after 1000ms"); }),
    });
    const tool = createExecTool({ cwd: "/ws", executor });
    const result = JSON.parse(await callTool(tool, { command: "sleep 9999", timeout: 1 }));
    expect(result.exit_code).toBe(124);
    expect(result.error).toMatch(/timed out/);
  });

  it("returns exec-error JSON when executor throws", async () => {
    const executor = makeMockExecutor({
      execute: vi.fn(async () => { throw new Error("docker daemon not running"); }),
    });
    const tool = createExecTool({ cwd: "/ws", executor });
    const result = JSON.parse(await callTool(tool, { command: "ls" }));
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/exec error/);
  });
});

describe("createExecTools", () => {
  it("returns just the exec tool", () => {
    const tools = createExecTools({ executor: makeMockExecutor() });
    expect(tools.map((t) => t.name)).toEqual(["exec"]);
  });
});

describe("HostExecutor + createExecTool integration", () => {
  it("runs a real command end-to-end", async () => {
    const tool = createExecTool({ executor: new HostExecutor() });
    const result = JSON.parse(await callTool(tool, { command: "echo hello" }));
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exit_code).toBe(0);
  });

  it("captures stderr", async () => {
    const tool = createExecTool({ executor: new HostExecutor() });
    const result = JSON.parse(await callTool(tool, { command: "echo err >&2" }));
    expect(result.stderr.trim()).toBe("err");
    expect(result.exit_code).toBe(0);
  });

  it("reports non-zero exit code", async () => {
    const tool = createExecTool({ executor: new HostExecutor() });
    const result = JSON.parse(await callTool(tool, { command: "exit 42" }));
    expect(result.exit_code).toBe(42);
  });
});
