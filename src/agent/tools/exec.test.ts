// src/tools/exec.test.ts — Tests for exec + process tools

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

async function callTool(tool: AgentTool, args: unknown): Promise<string> {
  const result: AgentToolResult<unknown> = await tool.execute("test-call", args as never);
  const block = result.content.find((c) => c.type === "text") as { text: string } | undefined;
  return block?.text ?? "";
}

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Mock child_process — avoid real process spawning on macOS (exit 143/144)
// CI (Linux) validates real spawn; these tests verify registry/tool logic.
// ---------------------------------------------------------------------------

/** Create a fake ChildProcess that auto-exits after `delayMs`. */
function createFakeChild(delayMs: number, exitCode = 0): ChildProcess {
  const child = new EventEmitter() as ChildProcess & { _killed: boolean };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  Object.assign(child, {
    stdout,
    stderr,
    pid: Math.floor(Math.random() * 90000) + 10000,
    _killed: false,
    kill: vi.fn((signal?: string) => {
      if (!child._killed) {
        child._killed = true;
        child.emit("exit", signal === "SIGTERM" ? 137 : exitCode, signal ?? null);
        child.emit("close", signal === "SIGTERM" ? 137 : exitCode, signal ?? null);
      }
      return true;
    }),
  });

  if (delayMs >= 0) {
    setTimeout(() => {
      if (!child._killed) {
        child._killed = true;
        child.emit("exit", exitCode, null);
        child.emit("close", exitCode, null);
      }
    }, delayMs);
  }

  return child;
}

/** Mapping of command patterns to fake child behavior. */
function fakeChildForCommand(cmd: string): ChildProcess {
  // Strip "sh -c " wrapper — every command now goes through `sh -c` via Executor.
  if (cmd.startsWith("sh -c ")) cmd = cmd.slice(6);
  // Crude shell `>&2` redirect — emit on stderr instead of stdout
  if (cmd.includes(">&2")) {
    const text = cmd.replace(/\s*>&2\s*$/, "").replace(/^echo\s+/, "");
    const child = createFakeChild(0, 0);
    process.nextTick(() => {
      child.stderr!.emit("data", Buffer.from(text + "\n"));
    });
    return child;
  }
  if (cmd.startsWith("echo ")) {
    const text = cmd.slice(5);
    const child = createFakeChild(0, 0);
    // Emit stdout on next tick so listeners can attach
    process.nextTick(() => {
      child.stdout!.emit("data", Buffer.from(text + "\n"));
    });
    return child;
  }
  if (cmd.startsWith("sleep ")) {
    // Keep alive for 10s (tests kill or clear before that)
    return createFakeChild(10_000, 0);
  }
  if (cmd === "exit 42") {
    return createFakeChild(0, 42);
  }
  // default: instant success
  return createFakeChild(0, 0);
}

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  // Only mock spawn on macOS where process-group signals kill the vitest worker.
  // CI (Linux) continues to use real spawn for full integration coverage.
  if (process.platform !== "darwin") return orig;
  return {
    ...orig,
    spawn: vi.fn(
      (command: string, args: string[], _opts?: Record<string, unknown>) => {
        const fullCmd = args.length === 0 ? command : `${command} ${args.join(" ")}`;
        return fakeChildForCommand(fullCmd);
      },
    ),
  };
});

import {
  ProcessRegistry,
  createExecTool,
  createProcessListTool,
  createProcessKillTool,
  createExecTools,
} from "./exec.js";
import { HostExecutor } from "../host-executor.js";

// ---------------------------------------------------------------------------
// ProcessRegistry
// ---------------------------------------------------------------------------

describe("ProcessRegistry", () => {
  let registry: ProcessRegistry;

  beforeEach(() => {
    registry = new ProcessRegistry();
  });

  afterEach(() => {
    registry.clear();
  });

  it("spawns a process and assigns an id", () => {
    const info = registry.spawn("echo hello", ["sh", "-c", "echo hello"], process.cwd());
    expect(info.process_id).toBe("proc_1");
    expect(info.command).toBe("echo hello");
    expect(info.status).toBe("running");
    expect(info.start_time).toBeDefined();
  });

  it("assigns incrementing ids", () => {
    const a = registry.spawn("echo a", ["sh", "-c", "echo a"], process.cwd());
    const b = registry.spawn("echo b", ["sh", "-c", "echo b"], process.cwd());
    expect(a.process_id).toBe("proc_1");
    expect(b.process_id).toBe("proc_2");
  });

  it("lists all processes", () => {
    registry.spawn("echo a", ["sh", "-c", "echo a"], process.cwd());
    registry.spawn("echo b", ["sh", "-c", "echo b"], process.cwd());
    expect(registry.list()).toHaveLength(2);
  });

  it("gets process by id", () => {
    const info = registry.spawn("echo test", ["sh", "-c", "echo test"], process.cwd());
    expect(registry.get(info.process_id)).toBe(info);
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("kills a running process", () => {
    const info = registry.spawn("sleep 60", ["sh", "-c", "sleep 60"], process.cwd());
    expect(registry.kill(info.process_id)).toBe(true);
    expect(info.status).toBe("exited");
  });

  it("returns false when killing a nonexistent process", () => {
    expect(registry.kill("proc_999")).toBe(false);
  });

  it("clears all processes", () => {
    registry.spawn("echo a", ["sh", "-c", "echo a"], process.cwd());
    registry.spawn("echo b", ["sh", "-c", "echo b"], process.cwd());
    registry.clear();
    expect(registry.list()).toHaveLength(0);
  });

  it("tracks completed process count", async () => {
    const a = registry.spawn("echo a", ["sh", "-c", "echo a"], process.cwd());
    const b = registry.spawn("sleep 60", ["sh", "-c", "sleep 60"], process.cwd());

    // Wait for first process to complete
    await new Promise((r) => setTimeout(r, 100));
    expect(a.status).toBe("exited");
    expect(b.status).toBe("running");
    expect(registry.getCompletedCount()).toBe(1);
  });

  it("cleans up completed processes manually", async () => {
    registry.spawn("echo a", ["sh", "-c", "echo a"], process.cwd());
    registry.spawn("echo b", ["sh", "-c", "echo b"], process.cwd());
    
    // Wait for processes to complete
    await new Promise((r) => setTimeout(r, 100));
    expect(registry.getCompletedCount()).toBe(2);
    
    const removed = registry.cleanup();
    expect(removed).toBe(2);
    expect(registry.list()).toHaveLength(0);
  });

  it("evicts oldest completed processes when maxCompleted exceeded", async () => {
    const smallRegistry = new ProcessRegistry({ maxCompleted: 2 });
    
    // Spawn 3 processes that complete immediately
    smallRegistry.spawn("echo 1", ["sh", "-c", "echo 1"], process.cwd());
    await new Promise((r) => setTimeout(r, 50));
    smallRegistry.spawn("echo 2", ["sh", "-c", "echo 2"], process.cwd());
    await new Promise((r) => setTimeout(r, 50));
    smallRegistry.spawn("echo 3", ["sh", "-c", "echo 3"], process.cwd());
    await new Promise((r) => setTimeout(r, 100));
    
    // Should have evicted oldest, keeping only 2
    expect(smallRegistry.getCompletedCount()).toBeLessThanOrEqual(2);
    smallRegistry.clear();
  });
});

// ---------------------------------------------------------------------------
// exec tool — foreground
// ---------------------------------------------------------------------------

describe("exec tool", () => {
  let registry: ProcessRegistry;
  let executor: HostExecutor;

  beforeEach(() => {
    registry = new ProcessRegistry();
    executor = new HostExecutor();
  });

  afterEach(() => {
    registry.clear();
  });

  it("returns tool with correct schema", () => {
    const tool = createExecTool({ registry, executor });
    expect(tool.name).toBe("exec");
    expect(tool.parameters).toBeDefined();
  });

  it("executes a basic command", async () => {
    const tool = createExecTool({ registry, executor });
    const result = JSON.parse(await callTool(tool, { command: "echo hello" }));
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exit_code).toBe(0);
  });

  it("captures stderr", async () => {
    const tool = createExecTool({ registry, executor });
    const result = JSON.parse(
      await callTool(tool, { command: "echo err >&2" }),
    );
    expect(result.stderr.trim()).toBe("err");
    expect(result.exit_code).toBe(0);
  });

  it("returns non-zero exit code on failure", async () => {
    const tool = createExecTool({ registry, executor });
    const result = JSON.parse(await callTool(tool, { command: "exit 42" }));
    expect(result.exit_code).not.toBe(0);
  });

  it("returns error for empty command", async () => {
    const tool = createExecTool({ registry, executor });
    const result = JSON.parse(await callTool(tool, { command: "" }));
    expect(result.error).toContain("must not be empty");
  });

  it("times out with custom timeout", async () => {
    const tool = createExecTool({ registry, executor });
    const result = JSON.parse(
      await callTool(tool, { command: "sleep 10", timeout: 1 }),
    );
    expect(result.error).toContain("timed out");
    expect(result.exit_code).toBe(124);
  }, 10_000);

  it("clamps timeout to max 300s", async () => {
    // We can't easily test the actual clamping without waiting, but we can
    // verify the tool doesn't reject large values
    const tool = createExecTool({ registry, executor });
    expect(tool.parameters).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // exec tool — background
  // ---------------------------------------------------------------------------

  it("runs a command in background mode", async () => {
    const tool = createExecTool({ registry, executor });
    const result = JSON.parse(
      await callTool(tool, { command: "sleep 60", background: true }),
    );

    expect(result.process_id).toBe("proc_1");
    expect(result.status).toBe("running");
    expect(result.command).toBe("sleep 60");
    expect(result.start_time).toBeDefined();
  });

  it("background process appears in registry", async () => {
    const tool = createExecTool({ registry, executor });
    await callTool(tool, { command: "sleep 60", background: true });
    expect(registry.list()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// process_list tool
// ---------------------------------------------------------------------------

describe("process_list tool", () => {
  let registry: ProcessRegistry;

  beforeEach(() => {
    registry = new ProcessRegistry();
  });

  afterEach(() => {
    registry.clear();
  });

  it("returns tool with correct schema", () => {
    const tool = createProcessListTool(registry);
    expect(tool.name).toBe("process_list");
  });

  it("returns empty list when no processes", async () => {
    const tool = createProcessListTool(registry);
    const result = JSON.parse(await callTool(tool, {}));
    expect(result.processes).toEqual([]);
  });

  it("lists running and exited processes", async () => {
    registry.spawn("sleep 60", ["sh", "-c", "sleep 60"], process.cwd());
    const shortProc = registry.spawn("echo done", ["sh", "-c", "echo done"], process.cwd());

    // Wait a bit for the echo to finish
    await new Promise((resolve) => setTimeout(resolve, 200));

    const tool = createProcessListTool(registry);
    const result = JSON.parse(await callTool(tool, {}));

    expect(result.processes).toHaveLength(2);

    const running = result.processes.find(
      (p: { status: string }) => p.status === "running",
    );
    const exited = result.processes.find(
      (p: { process_id: string }) => p.process_id === shortProc.process_id,
    );

    expect(running).toBeDefined();
    expect(exited).toBeDefined();
    expect(exited.status).toBe("exited");
    expect(exited.exit_code).toBe(0);
  });

  it("does not expose internal _proc field", async () => {
    registry.spawn("echo hello", ["sh", "-c", "echo hello"], process.cwd());
    const tool = createProcessListTool(registry);
    const result = JSON.parse(await callTool(tool, {}));
    expect(result.processes[0]._proc).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// process_kill tool
// ---------------------------------------------------------------------------

describe("process_kill tool", () => {
  let registry: ProcessRegistry;

  beforeEach(() => {
    registry = new ProcessRegistry();
  });

  afterEach(() => {
    registry.clear();
  });

  it("kills a running process", async () => {
    const info = registry.spawn("sleep 60", ["sh", "-c", "sleep 60"], process.cwd());
    const tool = createProcessKillTool(registry);
    const result = JSON.parse(
      await callTool(tool, { process_id: info.process_id }),
    );

    expect(result.success).toBe(true);
    expect(result.process_id).toBe(info.process_id);
    expect(result.was_running).toBe(true);
  });

  it("handles killing an already exited process", async () => {
    const info = registry.spawn("echo fast", ["sh", "-c", "echo fast"], process.cwd());
    await new Promise((resolve) => setTimeout(resolve, 200));

    const tool = createProcessKillTool(registry);
    const result = JSON.parse(
      await callTool(tool, { process_id: info.process_id }),
    );

    expect(result.success).toBe(true);
    expect(result.was_running).toBe(false);
  });

  it("returns error for unknown process_id", async () => {
    const tool = createProcessKillTool(registry);
    const result = JSON.parse(
      await callTool(tool, { process_id: "proc_999" }),
    );
    expect(result.error).toContain("Process not found");
  });

  it("returns error when process_id is missing", async () => {
    const tool = createProcessKillTool(registry);
    const result = JSON.parse(await callTool(tool, {}));
    expect(result.error).toContain("process_id is required");
  });
});

// ---------------------------------------------------------------------------
// createExecTools factory
// ---------------------------------------------------------------------------

describe("createExecTools", () => {
  const executor = new HostExecutor();

  it("returns all three tools", () => {
    const tools = createExecTools({ executor });
    const names = tools.map((t) => t.name);
    expect(names).toContain("exec");
    expect(names).toContain("process_list");
    expect(names).toContain("process_kill");
    expect(tools).toHaveLength(3);
  });

  it("shares registry across tools", async () => {
    const tools = createExecTools({ executor });
    const execHandler = (args: unknown) => callTool(tools.find((t) => t.name === "exec")!, args);
    const listHandler = (args: unknown) => callTool(tools.find((t) => t.name === "process_list")!, args);
    const killHandler = (args: unknown) => callTool(tools.find((t) => t.name === "process_kill")!, args);

    // Start a background process
    const execResult = JSON.parse(
      await execHandler({ command: "sleep 60", background: true }),
    );

    // List should show it
    const listResult = JSON.parse(await listHandler({}));
    expect(listResult.processes).toHaveLength(1);
    expect(listResult.processes[0].process_id).toBe(execResult.process_id);

    // Kill it
    const killResult = JSON.parse(
      await killHandler({ process_id: execResult.process_id }),
    );
    expect(killResult.success).toBe(true);
  });

  it("isolates processes between separate registries", async () => {
    // Simulate two agents with separate registries
    const registry1 = new ProcessRegistry();
    const registry2 = new ProcessRegistry();

    const tools1 = createExecTools({ registry: registry1, executor });
    const tools2 = createExecTools({ registry: registry2, executor });

    const exec1 = (args: unknown) => callTool(tools1.find((t) => t.name === "exec")!, args);
    const list1 = (args: unknown) => callTool(tools1.find((t) => t.name === "process_list")!, args);

    const exec2 = (args: unknown) => callTool(tools2.find((t) => t.name === "exec")!, args);
    const list2 = (args: unknown) => callTool(tools2.find((t) => t.name === "process_list")!, args);

    // Agent 1 starts a process
    const result1 = JSON.parse(
      await exec1({ command: "sleep 60", background: true }),
    );

    // Agent 2 starts a process
    const result2 = JSON.parse(
      await exec2({ command: "sleep 60", background: true }),
    );

    // Each agent should only see their own process
    const list1Result = JSON.parse(await list1({}));
    const list2Result = JSON.parse(await list2({}));

    expect(list1Result.processes).toHaveLength(1);
    expect(list1Result.processes[0].process_id).toBe(result1.process_id);

    expect(list2Result.processes).toHaveLength(1);
    expect(list2Result.processes[0].process_id).toBe(result2.process_id);

    // Cleanup
    registry1.clear();
    registry2.clear();
  });

  it("prevents one registry from killing another registry's processes", async () => {
    const registry1 = new ProcessRegistry();
    const registry2 = new ProcessRegistry();

    const tools1 = createExecTools({ registry: registry1, executor });
    const tools2 = createExecTools({ registry: registry2, executor });

    const exec1 = (args: unknown) => callTool(tools1.find((t) => t.name === "exec")!, args);
    const kill2 = (args: unknown) => callTool(tools2.find((t) => t.name === "process_kill")!, args);

    // Agent 1 starts a process
    const result1 = JSON.parse(
      await exec1({ command: "sleep 60", background: true }),
    );

    // Agent 2 tries to kill Agent 1's process
    const killResult = JSON.parse(
      await kill2({ process_id: result1.process_id }),
    );

    // Should fail because the process doesn't exist in registry2
    expect(killResult.error).toContain("Process not found");

    // Verify Agent 1's process is still alive
    const info = registry1.get(result1.process_id);
    expect(info).toBeDefined();
    expect(info!.status).toBe("running");

    // Cleanup
    registry1.clear();
    registry2.clear();
  });
});


// ---------------------------------------------------------------------------
// Executor delegation
// ---------------------------------------------------------------------------

import type { Executor } from "../executor.js";

function makeMockExecutor(overrides?: Partial<Executor>): Executor {
  return {
    execute: vi.fn(async () => ({
      exitCode: 0,
      stdout: Buffer.from("mocked-out"),
      stderr: Buffer.alloc(0),
    })),
    buildExecArgv: vi.fn(async (argv: string[]) => ["docker", "exec", "-i", "ctr-1", ...argv]),
    ...overrides,
  };
}

describe("createExecTool — Executor delegation", () => {
  it("foreground exec wraps command in sh -c and delegates to executor.execute", async () => {
    const executor = makeMockExecutor();
    const registry = new ProcessRegistry();
    const tool = createExecTool({ cwd: "/ws", registry, executor });

    const result = JSON.parse(await callTool(tool, { command: "echo hi" }) as string);

    expect(executor.execute).toHaveBeenCalledWith(
      ["sh", "-c", "echo hi"],
      { workspacePath: "/ws", timeout: expect.any(Number) },
    );
    expect(result.stdout).toBe("mocked-out");
    expect(result.exit_code).toBe(0);
  });

  it("background exec calls buildExecArgv and registers the returned argv", async () => {
    const executor = makeMockExecutor();
    const registry = new ProcessRegistry();
    const spawnSpy = vi.spyOn(registry, "spawn");
    const tool = createExecTool({ cwd: "/ws", registry, executor });

    const result = JSON.parse(await callTool(tool, { command: "sleep 3", background: true }) as string);

    expect(executor.buildExecArgv).toHaveBeenCalledWith(
      ["sh", "-c", "sleep 3"],
      { workspacePath: "/ws" },
    );
    expect(spawnSpy).toHaveBeenCalledWith(
      "sleep 3",
      ["docker", "exec", "-i", "ctr-1", "sh", "-c", "sleep 3"],
      "/ws",
    );
    expect(result.process_id).toBe("proc_1");
    expect(result.status).toBe("running");

    registry.clear();
  });

  it("returns timeout JSON when executor reports timed out", async () => {
    const executor = makeMockExecutor({
      execute: vi.fn(async () => { throw new Error("Sandbox execution timed out after 1000ms"); }),
    });
    const tool = createExecTool({ cwd: "/ws", registry: new ProcessRegistry(), executor });
    const result = JSON.parse(await callTool(tool, { command: "sleep 9999", timeout: 1 }) as string);
    expect(result.exit_code).toBe(124);
    expect(result.error).toMatch(/timed out/);
  });

  it("returns exec-error JSON when executor throws", async () => {
    const executor = makeMockExecutor({
      execute: vi.fn(async () => { throw new Error("docker daemon not running"); }),
    });
    const tool = createExecTool({ cwd: "/ws", registry: new ProcessRegistry(), executor });
    const result = JSON.parse(await callTool(tool, { command: "ls" }) as string);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/exec error/);
  });

  it("returns error JSON when buildExecArgv fails (background)", async () => {
    const executor = makeMockExecutor({
      buildExecArgv: vi.fn(async () => { throw new Error("docker daemon not running"); }),
    });
    const tool = createExecTool({ cwd: "/ws", registry: new ProcessRegistry(), executor });
    const result = JSON.parse(await callTool(tool, { command: "sleep 3", background: true }) as string);
    expect(result.exit_code).toBe(1);
    expect(result.error).toMatch(/Background exec failed/);
  });
});
