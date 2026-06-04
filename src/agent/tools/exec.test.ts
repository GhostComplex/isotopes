import { describe, it, expect, vi } from "vitest";
import { createExecTool, createExecTools } from "./exec.js";
import { HostExecutor } from "../middleware/executor.js";
import type { Executor } from "../middleware/executor.js";

function makeMockExecutor(): Executor {
  return {
    execute: vi.fn(async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })),
    buildExecArgv: vi.fn(async (argv: string[]) => argv),
  };
}

describe("createExecTool", () => {
  it("returns pi's bash tool", () => {
    const tool = createExecTool({ executor: makeMockExecutor() });
    expect(tool.name).toBe("bash");
    expect(tool.parameters).toBeDefined();
  });

  it("runs a real host command end-to-end", async () => {
    const tool = createExecTool({ executor: new HostExecutor() });
    const result = await tool.execute("test-call", { command: "echo hello" } as never);
    const block = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(block?.text).toMatch(/hello/);
  });

  it("rejects on non-zero exit (pi convention)", async () => {
    const tool = createExecTool({ executor: new HostExecutor() });
    await expect(tool.execute("test-call", { command: "exit 7" } as never))
      .rejects.toThrow(/exited with code 7/);
  });
});

describe("createExecTools", () => {
  it("returns just the bash tool", () => {
    const tools = createExecTools({ executor: makeMockExecutor() });
    expect(tools.map((t) => t.name)).toEqual(["bash"]);
  });
});
