// src/tools/subagent.test.ts — Unit tests for subagent tool

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  spawnSubagent,
  cancelSubagent,
  hasRunningSubagents,
  getActiveSubagentCount,
  getSupportedAgents,
} from "./subagent.js";

// Mock the subagent module
vi.mock("../subagent/index.js", () => {
  const mockBackend = {
    spawn: vi.fn(),
    cancel: vi.fn(),
    cancelAll: vi.fn(),
    activeCount: 0,
  };

  return {
    AcpxBackend: vi.fn(() => mockBackend),
    collectResult: vi.fn(),
    ACPX_AGENTS: new Set([
      "claude",
      "codex",
      "gemini",
      "cursor",
      "copilot",
      "opencode",
      "kimi",
      "qwen",
    ]),
  };
});

describe("subagent tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getSupportedAgents", () => {
    it("returns all supported agent names", () => {
      const agents = getSupportedAgents();
      expect(agents).toContain("claude");
      expect(agents).toContain("codex");
      expect(agents).toContain("gemini");
      expect(agents.length).toBe(8);
    });
  });

  describe("spawnSubagent", () => {
    it("spawns a sub-agent with default options", async () => {
      const { AcpxBackend } = await import("../subagent/index.js");
      const mockBackend = new AcpxBackend();

      // Mock spawn to return an async generator
      (mockBackend.spawn as ReturnType<typeof vi.fn>).mockImplementation(
        async function* () {
          yield { type: "start" };
          yield { type: "message", content: "Hello from sub-agent" };
          yield { type: "done", exitCode: 0 };
        },
      );

      const result = await spawnSubagent("Do something", { cwd: "/tmp" });

      expect(result.success).toBe(true);
      expect(result.output).toBe("Hello from sub-agent");
      expect(result.exitCode).toBe(0);
      expect(result.eventCount).toBe(3);
    });

    it("handles sub-agent errors", async () => {
      const { AcpxBackend } = await import("../subagent/index.js");
      const mockBackend = new AcpxBackend();

      (mockBackend.spawn as ReturnType<typeof vi.fn>).mockImplementation(
        async function* () {
          yield { type: "start" };
          yield { type: "error", error: "Something went wrong" };
          yield { type: "done", exitCode: 1 };
        },
      );

      const result = await spawnSubagent("Do something", { cwd: "/tmp" });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Something went wrong");
      expect(result.exitCode).toBe(1);
    });

    it("calls onEvent callback for each event", async () => {
      const { AcpxBackend } = await import("../subagent/index.js");
      const mockBackend = new AcpxBackend();

      (mockBackend.spawn as ReturnType<typeof vi.fn>).mockImplementation(
        async function* () {
          yield { type: "start" };
          yield { type: "message", content: "Test" };
          yield { type: "done", exitCode: 0 };
        },
      );

      const events: unknown[] = [];
      await spawnSubagent("Test", {
        cwd: "/tmp",
        onEvent: (e) => events.push(e),
      });

      expect(events.length).toBe(3);
      expect(events[0]).toEqual({ type: "start" });
    });

    it("handles spawn exceptions", async () => {
      const { AcpxBackend } = await import("../subagent/index.js");
      const mockBackend = new AcpxBackend();

      (mockBackend.spawn as ReturnType<typeof vi.fn>).mockImplementation(
        // eslint-disable-next-line require-yield
        async function* () {
          throw new Error("Spawn failed");
        },
      );

      const result = await spawnSubagent("Test", { cwd: "/tmp" });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Spawn failed");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("cancelSubagent", () => {
    it("cancels a specific task", async () => {
      const { AcpxBackend } = await import("../subagent/index.js");
      const mockBackend = new AcpxBackend();
      (mockBackend.cancel as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const result = cancelSubagent("task-123");

      expect(result).toBe(true);
      expect(mockBackend.cancel).toHaveBeenCalledWith("task-123");
    });

    it("cancels all tasks when no pattern", async () => {
      const { AcpxBackend } = await import("../subagent/index.js");
      const mockBackend = new AcpxBackend();

      const result = cancelSubagent();

      expect(result).toBe(true);
      expect(mockBackend.cancelAll).toHaveBeenCalled();
    });
  });

  describe("hasRunningSubagents", () => {
    it("returns true when agents are running", async () => {
      const { AcpxBackend } = await import("../subagent/index.js");
      const mockBackend = new AcpxBackend();
      Object.defineProperty(mockBackend, "activeCount", { value: 2, writable: true });

      const result = hasRunningSubagents();

      expect(result).toBe(true);
    });

    it("returns false when no agents running", async () => {
      const { AcpxBackend } = await import("../subagent/index.js");
      const mockBackend = new AcpxBackend();
      Object.defineProperty(mockBackend, "activeCount", { value: 0, writable: true });

      const result = hasRunningSubagents();

      expect(result).toBe(false);
    });
  });

  describe("getActiveSubagentCount", () => {
    it("returns the active count", async () => {
      const { AcpxBackend } = await import("../subagent/index.js");
      const mockBackend = new AcpxBackend();
      Object.defineProperty(mockBackend, "activeCount", { value: 3, writable: true });

      const count = getActiveSubagentCount();

      expect(count).toBe(3);
    });
  });
});
