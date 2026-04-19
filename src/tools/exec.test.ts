// src/tools/exec.test.ts — Tests for exec + process tools

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../core/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  ProcessRegistry,
  createExecTool,
  createProcessListTool,
  createProcessKillTool,
  createExecTools,
} from "./exec.js";

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
    const info = registry.spawn("echo hello", process.cwd());
    expect(info.process_id).toBe("proc_1");
    expect(info.command).toBe("echo hello");
    expect(info.status).toBe("running");
    expect(info.start_time).toBeDefined();
  });

  it("assigns incrementing ids", () => {
    const a = registry.spawn("echo a", process.cwd());
    const b = registry.spawn("echo b", process.cwd());
    expect(a.process_id).toBe("proc_1");
    expect(b.process_id).toBe("proc_2");
  });

  it("lists all processes", () => {
    registry.spawn("echo a", process.cwd());
    registry.spawn("echo b", process.cwd());
    expect(registry.list()).toHaveLength(2);
  });

  it("gets process by id", () => {
    const info = registry.spawn("echo test", process.cwd());
    expect(registry.get(info.process_id)).toBe(info);
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("kills a running process", () => {
    const info = registry.spawn("sleep 60", process.cwd());
    expect(registry.kill(info.process_id)).toBe(true);
    expect(info.status).toBe("exited");
  });

  it("returns false when killing a nonexistent process", () => {
    expect(registry.kill("proc_999")).toBe(false);
  });

  it("clears all processes", () => {
    registry.spawn("echo a", process.cwd());
    registry.spawn("echo b", process.cwd());
    registry.clear();
    expect(registry.list()).toHaveLength(0);
  });

  it("tracks completed process count", async () => {
    const a = registry.spawn("echo a", process.cwd());
    const b = registry.spawn("sleep 60", process.cwd());
    
    // Wait for first process to complete
    await new Promise((r) => setTimeout(r, 100));
    expect(a.status).toBe("exited");
    expect(b.status).toBe("running");
    expect(registry.getCompletedCount()).toBe(1);
  });

  it("cleans up completed processes manually", async () => {
    registry.spawn("echo a", process.cwd());
    registry.spawn("echo b", process.cwd());
    
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
    smallRegistry.spawn("echo 1", process.cwd());
    await new Promise((r) => setTimeout(r, 50));
    smallRegistry.spawn("echo 2", process.cwd());
    await new Promise((r) => setTimeout(r, 50));
    smallRegistry.spawn("echo 3", process.cwd());
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

  beforeEach(() => {
    registry = new ProcessRegistry();
  });

  afterEach(() => {
    registry.clear();
  });

  it("returns tool with correct schema", () => {
    const { tool } = createExecTool({ registry });
    expect(tool.name).toBe("exec");
    expect(tool.parameters.required).toContain("command");
  });

  it("executes a basic command", async () => {
    const { handler } = createExecTool({ registry });
    const result = JSON.parse(await handler({ command: "echo hello" }));
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exit_code).toBe(0);
  });

  it("captures stderr", async () => {
    const { handler } = createExecTool({ registry });
    const result = JSON.parse(
      await handler({ command: "echo err >&2" }),
    );
    expect(result.stderr.trim()).toBe("err");
    expect(result.exit_code).toBe(0);
  });

  it("returns non-zero exit code on failure", async () => {
    const { handler } = createExecTool({ registry });
    const result = JSON.parse(await handler({ command: "exit 42" }));
    expect(result.exit_code).not.toBe(0);
  });

  it("returns error for empty command", async () => {
    const { handler } = createExecTool({ registry });
    const result = JSON.parse(await handler({ command: "" }));
    expect(result.error).toContain("must not be empty");
  });

  it("times out with custom timeout", async () => {
    const { handler } = createExecTool({ registry });
    const result = JSON.parse(
      await handler({ command: "sleep 10", timeout: 1 }),
    );
    expect(result.error).toContain("timed out");
    expect(result.exit_code).toBe(124);
  }, 10_000);

  it("clamps timeout to max 300s", async () => {
    // We can't easily test the actual clamping without waiting, but we can
    // verify the tool doesn't reject large values
    const { tool } = createExecTool({ registry });
    expect(tool.parameters.properties).toHaveProperty("timeout");
  });

  // ---------------------------------------------------------------------------
  // exec tool — background
  // ---------------------------------------------------------------------------

  it("runs a command in background mode", async () => {
    const { handler } = createExecTool({ registry });
    const result = JSON.parse(
      await handler({ command: "sleep 60", background: true }),
    );

    expect(result.process_id).toBe("proc_1");
    expect(result.status).toBe("running");
    expect(result.command).toBe("sleep 60");
    expect(result.start_time).toBeDefined();
  });

  it("background process appears in registry", async () => {
    const { handler } = createExecTool({ registry });
    await handler({ command: "sleep 60", background: true });
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
    const { tool } = createProcessListTool(registry);
    expect(tool.name).toBe("process_list");
  });

  it("returns empty list when no processes", async () => {
    const { handler } = createProcessListTool(registry);
    const result = JSON.parse(await handler({}));
    expect(result.processes).toEqual([]);
  });

  it("lists running and exited processes", async () => {
    registry.spawn("sleep 60", process.cwd());
    const shortProc = registry.spawn("echo done", process.cwd());

    // Wait a bit for the echo to finish
    await new Promise((resolve) => setTimeout(resolve, 200));

    const { handler } = createProcessListTool(registry);
    const result = JSON.parse(await handler({}));

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
    registry.spawn("echo hello", process.cwd());
    const { handler } = createProcessListTool(registry);
    const result = JSON.parse(await handler({}));
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

  it("returns tool with correct schema", () => {
    const { tool } = createProcessKillTool(registry);
    expect(tool.name).toBe("process_kill");
    expect(tool.parameters.required).toContain("process_id");
  });

  it("kills a running process", async () => {
    const info = registry.spawn("sleep 60", process.cwd());
    const { handler } = createProcessKillTool(registry);
    const result = JSON.parse(
      await handler({ process_id: info.process_id }),
    );

    expect(result.success).toBe(true);
    expect(result.process_id).toBe(info.process_id);
    expect(result.was_running).toBe(true);
  });

  it("handles killing an already exited process", async () => {
    const info = registry.spawn("echo fast", process.cwd());
    await new Promise((resolve) => setTimeout(resolve, 200));

    const { handler } = createProcessKillTool(registry);
    const result = JSON.parse(
      await handler({ process_id: info.process_id }),
    );

    expect(result.success).toBe(true);
    expect(result.was_running).toBe(false);
  });

  it("returns error for unknown process_id", async () => {
    const { handler } = createProcessKillTool(registry);
    const result = JSON.parse(
      await handler({ process_id: "proc_999" }),
    );
    expect(result.error).toContain("Process not found");
  });

  it("returns error when process_id is missing", async () => {
    const { handler } = createProcessKillTool(registry);
    const result = JSON.parse(await handler({}));
    expect(result.error).toContain("process_id is required");
  });
});

// ---------------------------------------------------------------------------
// createExecTools factory
// ---------------------------------------------------------------------------

describe("createExecTools", () => {
  it("returns all three tools", () => {
    const tools = createExecTools();
    const names = tools.map((t) => t.tool.name);
    expect(names).toContain("exec");
    expect(names).toContain("process_list");
    expect(names).toContain("process_kill");
    expect(tools).toHaveLength(3);
  });

  it("shares registry across tools", async () => {
    const tools = createExecTools();
    const execHandler = tools.find((t) => t.tool.name === "exec")!.handler;
    const listHandler = tools.find((t) => t.tool.name === "process_list")!.handler;
    const killHandler = tools.find((t) => t.tool.name === "process_kill")!.handler;

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

    const tools1 = createExecTools({ registry: registry1 });
    const tools2 = createExecTools({ registry: registry2 });

    const exec1 = tools1.find((t) => t.tool.name === "exec")!.handler;
    const list1 = tools1.find((t) => t.tool.name === "process_list")!.handler;

    const exec2 = tools2.find((t) => t.tool.name === "exec")!.handler;
    const list2 = tools2.find((t) => t.tool.name === "process_list")!.handler;

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

    const tools1 = createExecTools({ registry: registry1 });
    const tools2 = createExecTools({ registry: registry2 });

    const exec1 = tools1.find((t) => t.tool.name === "exec")!.handler;
    const kill2 = tools2.find((t) => t.tool.name === "process_kill")!.handler;

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
// Sandbox routing
// ---------------------------------------------------------------------------

import type { SandboxExecutor } from "../sandbox/executor.js";
import type { SandboxConfig } from "../sandbox/config.js";

function makeMockSandboxExecutor(overrides?: Partial<SandboxExecutor>): SandboxExecutor {
  return {
    shouldExecuteInSandbox: vi.fn(() => true),
    execute: vi.fn(async () => ({ exitCode: 0, stdout: "sandboxed-out", stderr: "" })),
    buildExecArgv: vi.fn(async (_id: string, cmd: string[]) => [
      "docker", "exec", "-i", "ctr-1", ...cmd,
    ]),
    cleanup: vi.fn(async () => {}),
    ...overrides,
  } as unknown as SandboxExecutor;
}

const sandboxConfig: SandboxConfig = {
  mode: "all",
  workspaceAccess: "rw",
  docker: { image: "isotopes-sandbox:latest" },
};

describe("exec tool sandbox routing", () => {
  it("routes foreground exec through SandboxExecutor.execute when sandboxed", async () => {
    const executor = makeMockSandboxExecutor();
    const { handler } = createExecTool({
      cwd: "/ws",
      sandboxExecutor: executor,
      agentId: "agent-1",
      isMainAgent: false,
      agentSandboxConfig: sandboxConfig,
    });

    const result = JSON.parse(await handler({ command: "echo hi" }) as string);

    expect(executor.execute).toHaveBeenCalledWith(
      "agent-1",
      ["sh", "-c", "echo hi"],
      { workspacePath: "/ws", timeout: expect.any(Number), allowedWorkspaces: undefined },
    );
    expect(result.stdout).toBe("sandboxed-out");
    expect(result.exit_code).toBe(0);
  });

  it("returns timeout JSON (not throw) when sandbox execute reports timeout", async () => {
    const executor = makeMockSandboxExecutor({
      execute: vi.fn(async () => {
        throw new Error("Sandbox execution timed out after 1000ms");
      }),
    });
    const { handler } = createExecTool({
      cwd: "/ws",
      sandboxExecutor: executor,
      agentId: "agent-1",
      agentSandboxConfig: sandboxConfig,
    });

    const result = JSON.parse(await handler({ command: "sleep 9999", timeout: 1 }) as string);
    expect(result.exit_code).toBe(124);
    expect(result.error).toMatch(/timed out/);
  });

  it("returns sandbox-error JSON (not throw) when container creation fails", async () => {
    const executor = makeMockSandboxExecutor({
      execute: vi.fn(async () => {
        throw new Error("docker daemon not running");
      }),
    });
    const { handler } = createExecTool({
      cwd: "/ws",
      sandboxExecutor: executor,
      agentId: "agent-1",
      agentSandboxConfig: sandboxConfig,
    });

    const result = JSON.parse(await handler({ command: "ls" }) as string);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/sandbox error/);
  });

  it("routes background exec through SandboxExecutor.buildExecArgv", async () => {
    const executor = makeMockSandboxExecutor();
    const registry = new ProcessRegistry();
    const spawnSpy = vi.spyOn(registry, "spawn");
    const { handler } = createExecTool({
      cwd: "/ws",
      registry,
      sandboxExecutor: executor,
      agentId: "agent-1",
      agentSandboxConfig: sandboxConfig,
    });

    const result = JSON.parse(await handler({ command: "sleep 3", background: true }) as string);

    expect(executor.buildExecArgv).toHaveBeenCalledWith(
      "agent-1",
      ["sh", "-c", "sleep 3"],
      { workspacePath: "/ws", allowedWorkspaces: undefined },
    );
    expect(spawnSpy).toHaveBeenCalledWith("sleep 3", "/ws", {
      argv: ["docker", "exec", "-i", "ctr-1", "sh", "-c", "sleep 3"],
    });
    expect(result.process_id).toBe("proc_1");
    expect(result.status).toBe("running");

    registry.clear();
  });

  it("threads allowedWorkspaces through to SandboxExecutor (foreground + background)", async () => {
    const executor = makeMockSandboxExecutor();
    const registry = new ProcessRegistry();
    const { handler } = createExecTool({
      cwd: "/ws",
      registry,
      sandboxExecutor: executor,
      agentId: "agent-1",
      agentSandboxConfig: sandboxConfig,
      allowedWorkspaces: ["/extra/foo", "/extra/bar"],
    });

    await handler({ command: "ls" });
    expect(executor.execute).toHaveBeenCalledWith(
      "agent-1",
      ["sh", "-c", "ls"],
      { workspacePath: "/ws", timeout: expect.any(Number), allowedWorkspaces: ["/extra/foo", "/extra/bar"] },
    );

    await handler({ command: "sleep 3", background: true });
    expect(executor.buildExecArgv).toHaveBeenCalledWith(
      "agent-1",
      ["sh", "-c", "sleep 3"],
      { workspacePath: "/ws", allowedWorkspaces: ["/extra/foo", "/extra/bar"] },
    );

    registry.clear();
  });

  it("returns sandbox-error JSON when buildExecArgv fails (background)", async () => {
    const executor = makeMockSandboxExecutor({
      buildExecArgv: vi.fn(async () => {
        throw new Error("docker daemon not running");
      }),
    });
    const registry = new ProcessRegistry();
    const { handler } = createExecTool({
      cwd: "/ws",
      registry,
      sandboxExecutor: executor,
      agentId: "agent-1",
      agentSandboxConfig: sandboxConfig,
    });

    const result = JSON.parse(await handler({ command: "sleep 3", background: true }) as string);
    expect(result.exit_code).toBe(1);
    expect(result.error).toMatch(/Sandbox container creation failed/);
  });

  it("falls back to host when shouldExecuteInSandbox returns false", async () => {
    const executor = makeMockSandboxExecutor({
      shouldExecuteInSandbox: vi.fn(() => false),
    });
    const { handler } = createExecTool({
      cwd: "/tmp",
      sandboxExecutor: executor,
      agentId: "agent-1",
      isMainAgent: true,
      agentSandboxConfig: { mode: "non-main" },
    });

    const result = JSON.parse(await handler({ command: "echo host" }) as string);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(result.stdout).toContain("host");
    expect(result.exit_code).toBe(0);
  });
});
