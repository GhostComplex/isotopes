// src/tools/spawn-agent.test.ts — Tests for spawnAgent tool and backend singleton
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RunEvent } from "../agents/types.js";

const spawnMock = vi.fn();
const cancelMock = vi.fn();
const cancelAllMock = vi.fn();

vi.mock("../agents/index.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/index.js")>(
    "../agents/index.js",
  );
  return {
    ...actual,
    AgentRuntime: vi.fn().mockImplementation((opts?: { allowedWorkspaceRoots?: string[] }) => ({
      spawn: spawnMock,
      cancel: cancelMock,
      cancelAll: cancelAllMock,
      workspacesKey: (opts?.allowedWorkspaceRoots ?? []).slice().sort().join(":"),
      get activeCount() {
        return 0;
      },
      getExternalRunnerIds: () => ["claude"],
      hasBuiltinRunner: () => false,
    })),
  };
});

async function* eventGen(...events: RunEvent[]): AsyncGenerator<RunEvent> {
  for (const e of events) yield e;
}

beforeEach(() => {
  spawnMock.mockReset();
  cancelMock.mockReset();
  cancelAllMock.mockReset();
});

describe("initSpawnBackend / getSpawnBackend", () => {
  it("returns undefined when not initialized", async () => {
    vi.resetModules();
    const { getSpawnBackend } = await import("./spawn-agent.js");
    expect(getSpawnBackend()).toBeUndefined();
  });

  it("returns backend after init", async () => {
    vi.resetModules();
    const { initSpawnBackend, getSpawnBackend } = await import("./spawn-agent.js");
    initSpawnBackend({ config: { claude: { permissionMode: "allowlist", allowedTools: ["Read"] }, useThread: true, showToolCalls: true } });
    expect(getSpawnBackend()).toBeDefined();
  });

  it("caches backend per workspace key", async () => {
    vi.resetModules();
    const { initSpawnBackend, getSpawnBackend } = await import("./spawn-agent.js");
    initSpawnBackend({ config: { claude: { permissionMode: "allowlist", allowedTools: [] }, useThread: true, showToolCalls: true } });
    const a = getSpawnBackend(["/w1"]);
    const b = getSpawnBackend(["/w1"]);
    expect(a).toBe(b);
    const c = getSpawnBackend(["/w2"]);
    expect(c).not.toBe(a);
  });
});

describe("spawnAgent", () => {
  it("returns success result with collected output", async () => {
    vi.resetModules();
    const { initSpawnBackend, spawnAgent } = await import("./spawn-agent.js");
    initSpawnBackend({ config: { claude: { permissionMode: "allowlist", allowedTools: [] }, useThread: true, showToolCalls: true } });
    spawnMock.mockReturnValue(
      eventGen(
        { type: "run:start" },
        { type: "run:message", content: "hello" },
        { type: "run:done", exitCode: 0 },
      ),
    );

    const result = await spawnAgent("task", { agent: "claude", cwd: process.cwd() });
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
    expect(result.exitCode).toBe(0);
    expect(result.eventCount).toBe(3);
  });

  it("returns failure when spawn throws", async () => {
    vi.resetModules();
    const { initSpawnBackend, spawnAgent } = await import("./spawn-agent.js");
    initSpawnBackend({ config: { claude: { permissionMode: "allowlist", allowedTools: [] }, useThread: true, showToolCalls: true } });
    spawnMock.mockImplementation(() => {
      throw new Error("boom");
    });
    const result = await spawnAgent("task", { agent: "claude", cwd: process.cwd() });
    expect(result.success).toBe(false);
    expect(result.error).toContain("boom");
  });

  it("streams events to onEvent callback", async () => {
    vi.resetModules();
    const { initSpawnBackend, spawnAgent } = await import("./spawn-agent.js");
    initSpawnBackend({ config: { claude: { permissionMode: "allowlist", allowedTools: [] }, useThread: true, showToolCalls: true } });
    spawnMock.mockReturnValue(
      eventGen(
        { type: "run:start" },
        { type: "run:tool_use", toolName: "Read" },
        { type: "run:done", exitCode: 0 },
      ),
    );
    const events: RunEvent[] = [];
    await spawnAgent("t", {
      agent: "claude",
      cwd: process.cwd(),
      onEvent: (e) => {
        events.push(e);
      },
    });
    expect(events).toHaveLength(3);
    expect(events[1]).toEqual({ type: "run:tool_use", toolName: "Read" });
  });

  it("creates a session and injects SessionManager for builtin spawns", async () => {
    vi.resetModules();
    const { initSpawnBackend, spawnAgent, setSpawnSessionStoreFactory } = await import("./spawn-agent.js");
    initSpawnBackend({ config: { claude: { permissionMode: "allowlist", allowedTools: [] }, useThread: true, showToolCalls: true } });

    const fakeSessionManager = { fake: true };
    const fakeStore = {
      create: vi.fn(async () => ({ id: "sess-1" })),
      getSessionManager: vi.fn(async () => fakeSessionManager),
    };
    setSpawnSessionStoreFactory(() => fakeStore as never);

    spawnMock.mockReturnValue(
      eventGen(
        { type: "run:start" },
        { type: "run:message", content: "hello" },
        { type: "run:done", exitCode: 0 },
      ),
    );

    await spawnAgent("t", {
      agent: "subagent",
      cwd: process.cwd(),
      parentAgentId: "main",
      targetAgentId: "subagent",
      builtin: {
        mode: "subagent",
        provider: { type: "anthropic", model: "claude-sonnet-4-5" } as never,
        tools: { list: () => [] } as never,
      },
    });

    expect(fakeStore.create).toHaveBeenCalledWith("subagent");
    expect(fakeStore.getSessionManager).toHaveBeenCalledWith("sess-1");
    const builtinArg = spawnMock.mock.calls[0][1].builtin;
    expect(builtinArg.sessionManager).toBe(fakeSessionManager);

    setSpawnSessionStoreFactory(undefined);
  });

  it("deletes the orphan session if SessionManager is unavailable", async () => {
    vi.resetModules();
    const { initSpawnBackend, spawnAgent, setSpawnSessionStoreFactory } = await import("./spawn-agent.js");
    initSpawnBackend({ config: { claude: { permissionMode: "allowlist", allowedTools: [] }, useThread: true, showToolCalls: true } });

    const fakeStore = {
      create: vi.fn(async () => ({ id: "sess-orphan" })),
      getSessionManager: vi.fn(async () => undefined),
      delete: vi.fn(async () => {}),
    };
    setSpawnSessionStoreFactory(() => fakeStore as never);

    spawnMock.mockReturnValue(
      eventGen({ type: "run:start" }, { type: "run:done", exitCode: 0 }),
    );

    await spawnAgent("t", {
      agent: "subagent",
      cwd: process.cwd(),
      parentAgentId: "main",
      targetAgentId: "subagent",
      builtin: {
        mode: "subagent",
        provider: { type: "anthropic", model: "claude-sonnet-4-5" } as never,
        tools: { list: () => [] } as never,
      },
    });

    expect(fakeStore.delete).toHaveBeenCalledWith("sess-orphan");
    const builtinArg = spawnMock.mock.calls[0][1].builtin;
    expect(builtinArg.sessionManager).toBeUndefined();

    setSpawnSessionStoreFactory(undefined);
  });

  it("deletes the orphan session if getSessionManager throws", async () => {
    vi.resetModules();
    const { initSpawnBackend, spawnAgent, setSpawnSessionStoreFactory } = await import("./spawn-agent.js");
    initSpawnBackend({ config: { claude: { permissionMode: "allowlist", allowedTools: [] }, useThread: true, showToolCalls: true } });

    const fakeStore = {
      create: vi.fn(async () => ({ id: "sess-throw" })),
      getSessionManager: vi.fn(async () => { throw new Error("nope"); }),
      delete: vi.fn(async () => {}),
    };
    setSpawnSessionStoreFactory(() => fakeStore as never);

    spawnMock.mockReturnValue(
      eventGen({ type: "run:start" }, { type: "run:done", exitCode: 0 }),
    );

    await spawnAgent("t", {
      agent: "subagent",
      cwd: process.cwd(),
      parentAgentId: "main",
      targetAgentId: "subagent",
      builtin: {
        mode: "subagent",
        provider: { type: "anthropic", model: "claude-sonnet-4-5" } as never,
        tools: { list: () => [] } as never,
      },
    });

    expect(fakeStore.delete).toHaveBeenCalledWith("sess-throw");

    setSpawnSessionStoreFactory(undefined);
  });

  it("does not touch the store for claude (non-builtin) spawns", async () => {
    vi.resetModules();
    const { initSpawnBackend, spawnAgent, setSpawnSessionStoreFactory } = await import("./spawn-agent.js");
    initSpawnBackend({ config: { claude: { permissionMode: "allowlist", allowedTools: [] }, useThread: true, showToolCalls: true } });

    const fakeStore = {
      create: vi.fn(),
      getSessionManager: vi.fn(),
    };
    setSpawnSessionStoreFactory(() => fakeStore as never);

    spawnMock.mockReturnValue(
      eventGen({ type: "run:start" }, { type: "run:done", exitCode: 0 }),
    );

    await spawnAgent("t", { agent: "claude", cwd: process.cwd() });

    expect(fakeStore.create).not.toHaveBeenCalled();
    expect(fakeStore.getSessionManager).not.toHaveBeenCalled();

    setSpawnSessionStoreFactory(undefined);
  });
});

describe("getSupportedAgents", () => {
  it("returns claude by default", async () => {
    vi.resetModules();
    const { getSupportedAgents } = await import("./spawn-agent.js");
    expect(getSupportedAgents()).toContain("claude");
  });

  it("returns configured agents after init", async () => {
    vi.resetModules();
    const { initSpawnBackend, getSupportedAgents } = await import("./spawn-agent.js");
    initSpawnBackend({ config: { claude: { permissionMode: "allowlist", allowedTools: [] }, useThread: true, showToolCalls: true } });
    expect(getSupportedAgents()).toContain("claude");
  });
});
