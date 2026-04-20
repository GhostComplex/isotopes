// src/tools/subagent.test.ts — Tests for spawnSubagent tool and backend singleton
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SubagentEvent } from "../subagent/types.js";

const spawnMock = vi.fn();
const cancelMock = vi.fn();
const cancelAllMock = vi.fn();

vi.mock("../subagent/index.js", async () => {
  const actual = await vi.importActual<typeof import("../subagent/index.js")>(
    "../subagent/index.js",
  );
  return {
    ...actual,
    SubagentBackend: vi.fn().mockImplementation(() => ({
      spawn: spawnMock,
      cancel: cancelMock,
      cancelAll: cancelAllMock,
      get activeCount() {
        return 0;
      },
    })),
  };
});

async function* eventGen(...events: SubagentEvent[]): AsyncGenerator<SubagentEvent> {
  for (const e of events) yield e;
}

beforeEach(() => {
  spawnMock.mockReset();
  cancelMock.mockReset();
  cancelAllMock.mockReset();
});

describe("initSubagentBackend / getSubagentBackend", () => {
  it("returns undefined when not initialized", async () => {
    vi.resetModules();
    const { getSubagentBackend } = await import("./subagent.js");
    expect(getSubagentBackend()).toBeUndefined();
  });

  it("returns backend after init", async () => {
    vi.resetModules();
    const { initSubagentBackend, getSubagentBackend } = await import("./subagent.js");
    initSubagentBackend({ permissionMode: "allowlist", allowedTools: ["Read"] });
    expect(getSubagentBackend()).toBeDefined();
  });

  it("caches backend per workspace key", async () => {
    vi.resetModules();
    const { initSubagentBackend, getSubagentBackend } = await import("./subagent.js");
    initSubagentBackend({ permissionMode: "allowlist" });
    const a = getSubagentBackend(["/w1"]);
    const b = getSubagentBackend(["/w1"]);
    expect(a).toBe(b);
    const c = getSubagentBackend(["/w2"]);
    expect(c).not.toBe(a);
  });
});

describe("spawnSubagent", () => {
  it("returns success result with collected output", async () => {
    vi.resetModules();
    const { initSubagentBackend, spawnSubagent } = await import("./subagent.js");
    initSubagentBackend({ permissionMode: "allowlist" });
    spawnMock.mockReturnValue(
      eventGen(
        { type: "start" },
        { type: "message", content: "hello" },
        { type: "done", exitCode: 0 },
      ),
    );

    const result = await spawnSubagent("task", { agent: "claude", cwd: process.cwd() });
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
    expect(result.exitCode).toBe(0);
    expect(result.eventCount).toBe(3);
  });

  it("returns failure when spawn throws", async () => {
    vi.resetModules();
    const { initSubagentBackend, spawnSubagent } = await import("./subagent.js");
    initSubagentBackend({ permissionMode: "allowlist" });
    spawnMock.mockImplementation(() => {
      throw new Error("boom");
    });
    const result = await spawnSubagent("task", { agent: "claude", cwd: process.cwd() });
    expect(result.success).toBe(false);
    expect(result.error).toContain("boom");
  });

  it("streams events to onEvent callback", async () => {
    vi.resetModules();
    const { initSubagentBackend, spawnSubagent } = await import("./subagent.js");
    initSubagentBackend({ permissionMode: "allowlist" });
    spawnMock.mockReturnValue(
      eventGen(
        { type: "start" },
        { type: "tool_use", toolName: "Read" },
        { type: "done", exitCode: 0 },
      ),
    );
    const events: SubagentEvent[] = [];
    await spawnSubagent("t", {
      agent: "claude",
      cwd: process.cwd(),
      onEvent: (e) => {
        events.push(e);
      },
    });
    expect(events).toHaveLength(3);
    expect(events[1]).toEqual({ type: "tool_use", toolName: "Read" });
  });
});

describe("getSupportedAgents", () => {
  it("returns claude and builtin", async () => {
    const { getSupportedAgents } = await import("./subagent.js");
    expect(getSupportedAgents()).toEqual(["claude", "builtin"]);
  });
});
