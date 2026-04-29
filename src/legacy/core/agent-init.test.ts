import { describe, it, expect, vi, beforeEach } from "vitest";
import { initializeAgent } from "./agent-init.js";
import type { AgentConfigFile } from "../../config.js";
import { PiMonoCore } from "./pi-mono.js";
import { DefaultAgentManager } from "./agent-manager.js";
import { createMockAgentCache } from "./test-helpers.js";
import type { SandboxExecutor } from "../sandbox/executor.js";

function makeMockSandboxExecutor(): SandboxExecutor {
  // Only fields touched by initializeAgent matter; sandbox gating uses
  // shouldSandbox(agentConfig.sandbox) — not any executor method.
  return {
    execute: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    buildExecArgv: vi.fn(async (_id: string, cmd: string[]) => ["docker", "exec", "ctr", ...cmd]),
    cleanup: vi.fn(async () => {}),
  } as unknown as SandboxExecutor;
}

function makeMinimalAgentFile(overrides?: Partial<AgentConfigFile>): AgentConfigFile {
  return {
    id: "test-agent",
    ...overrides,
  } as AgentConfigFile;
}

describe("initializeAgent", () => {
  let core: PiMonoCore;
  let agentManager: DefaultAgentManager;
  const mockCache = createMockAgentCache();

  beforeEach(() => {
    core = new PiMonoCore({ type: "anthropic", defaultModel: "claude-opus-4.5" });
    vi.spyOn(core, "setToolRegistry");
    agentManager = new DefaultAgentManager(core);
    vi.spyOn(agentManager, "create").mockResolvedValue(mockCache);
  });

  it("registers workspace tools and returns them", async () => {
    const result = await initializeAgent({
      agentFile: makeMinimalAgentFile(),
      core,
      agentManager,
    });

    expect(result.instance).toBe(mockCache);
    expect(result.toolRegistry.list().length).toBeGreaterThan(0);

    const toolNames = result.toolRegistry.list().map((t) => t.name);
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("write_file");
    expect(toolNames).toContain("edit");
    expect(toolNames).toContain("list_dir");
    expect(toolNames).toContain("get_current_time");
  });

  it("calls core.setToolRegistry", async () => {
    await initializeAgent({
      agentFile: makeMinimalAgentFile(),
      core,
      agentManager,
    });

    expect(core.setToolRegistry).toHaveBeenCalledWith("test-agent", expect.anything());
  });

  it("always registers exec tools", async () => {
    const result = await initializeAgent({
      agentFile: makeMinimalAgentFile(),
      core,
      agentManager,
    });

    const toolNames = result.toolRegistry.list().map((t) => t.name);
    expect(toolNames).toContain("exec");
  });

  it("skips react tools when no transportContext provided", async () => {
    const result = await initializeAgent({
      agentFile: makeMinimalAgentFile(),
      core,
      agentManager,
    });

    const toolNames = result.toolRegistry.list().map((t) => t.name);
    expect(toolNames).not.toContain("reply");
    expect(toolNames).not.toContain("react");
  });

  it("passes agentConfig to agentManager.create with workspace options", async () => {
    const result = await initializeAgent({
      agentFile: makeMinimalAgentFile(),
      core,
      agentManager,
    });

    expect(agentManager.create).toHaveBeenCalledWith(
      result.agentConfig,
      expect.objectContaining({
        workspacePath: expect.any(String),
        toolGuardPrompt: expect.any(String),
        initialSystemPrompt: expect.any(String),
      }),
    );
  });

  it("registers send_message when spawning enabled and no sandbox", async () => {
    const { AgentRuntime } = await import("../agents/runtime.js");
    const runtime = new AgentRuntime({ core });
    const result = await initializeAgent({
      agentFile: makeMinimalAgentFile(),
      spawning: { enabled: true },
      core,
      agentManager,
      runtime,
    });

    const toolNames = result.toolRegistry.list().map((t) => t.name);
    expect(toolNames).toContain("send_message");
  });

  it("does not register send_message when sandbox is active (issue #440)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { AgentRuntime } = await import("../agents/runtime.js");
    const runtime = new AgentRuntime({ core });

    const result = await initializeAgent({
      agentFile: makeMinimalAgentFile({ sandbox: { mode: "all" } }),
      sandbox: { mode: "all", docker: { image: "isotopes-sandbox:latest" } },
      spawning: { enabled: true },
      sandboxExecutor: makeMockSandboxExecutor(),
      core,
      agentManager,
      runtime,
    });

    const toolNames = result.toolRegistry.list().map((t) => t.name);
    expect(toolNames).not.toContain("send_message");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Spawning tools disabled for test-agent"),
    );

    warnSpy.mockRestore();
  });
});
