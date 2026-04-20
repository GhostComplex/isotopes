import { describe, it, expect, vi, beforeEach } from "vitest";
import { initializeAgent } from "./agent-init.js";
import type { AgentConfigFile } from "./config.js";
import { PiMonoCore } from "./pi-mono.js";
import { DefaultAgentManager } from "./agent-manager.js";
import { createMockAgentInstance } from "./test-helpers.js";

function makeMinimalAgentFile(overrides?: Partial<AgentConfigFile>): AgentConfigFile {
  return {
    id: "test-agent",
    ...overrides,
  } as AgentConfigFile;
}

describe("initializeAgent", () => {
  let core: PiMonoCore;
  let agentManager: DefaultAgentManager;
  const mockInstance = createMockAgentInstance();

  beforeEach(() => {
    core = new PiMonoCore();
    vi.spyOn(core, "setToolRegistry");
    agentManager = new DefaultAgentManager(core);
    vi.spyOn(agentManager, "create").mockResolvedValue(mockInstance);
  });

  it("registers workspace tools and returns them", async () => {
    const result = await initializeAgent({
      agentFile: makeMinimalAgentFile(),
      core,
      agentManager,
    });

    expect(result.instance).toBe(mockInstance);
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

  it("registers exec tools when CLI guard is enabled", async () => {
    const result = await initializeAgent({
      agentFile: makeMinimalAgentFile({ tools: { cli: true } }),
      core,
      agentManager,
    });

    const toolNames = result.toolRegistry.list().map((t) => t.name);
    expect(toolNames).toContain("exec");
  });

  it("skips exec tools when CLI guard is disabled", async () => {
    const result = await initializeAgent({
      agentFile: makeMinimalAgentFile({ tools: { cli: false } }),
      core,
      agentManager,
    });

    const toolNames = result.toolRegistry.list().map((t) => t.name);
    expect(toolNames).not.toContain("exec");
  });

  it("skips reply/react tools when no transportContext provided", async () => {
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
        baseSystemPrompt: expect.any(String),
      }),
    );
  });
});
