// src/subagent/index.test.ts — Integration tests for SubagentManager

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SubagentManager } from "./index.js";
import { AcpxBackend } from "./acpx-backend.js";
import type { AcpxEvent, SubagentTask } from "./types.js";
import { ACPX_AGENTS } from "./types.js";

// ---------------------------------------------------------------------------
// ACPX_AGENTS constant
// ---------------------------------------------------------------------------

describe("ACPX_AGENTS", () => {
  it("contains all known agents", () => {
    expect(ACPX_AGENTS.has("claude")).toBe(true);
    expect(ACPX_AGENTS.has("codex")).toBe(true);
    expect(ACPX_AGENTS.has("gemini")).toBe(true);
    expect(ACPX_AGENTS.has("cursor")).toBe(true);
    expect(ACPX_AGENTS.has("copilot")).toBe(true);
    expect(ACPX_AGENTS.has("opencode")).toBe(true);
    expect(ACPX_AGENTS.has("kimi")).toBe(true);
    expect(ACPX_AGENTS.has("qwen")).toBe(true);
  });

  it("does not contain unknown agents", () => {
    expect(ACPX_AGENTS.has("gpt")).toBe(false);
    expect(ACPX_AGENTS.has("")).toBe(false);
  });

  it("has exactly 8 agents", () => {
    expect(ACPX_AGENTS.size).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// SubagentManager
// ---------------------------------------------------------------------------

describe("SubagentManager", () => {
  let backend: AcpxBackend;
  let sendMessage: ReturnType<typeof vi.fn>;
  let createThread: ReturnType<typeof vi.fn>;
  let manager: SubagentManager;

  // Mock events returned by backend.spawn
  let mockEvents: AcpxEvent[];

  beforeEach(() => {
    backend = new AcpxBackend();
    sendMessage = vi.fn().mockResolvedValue({ id: "msg-1" });
    createThread = vi.fn().mockResolvedValue({ id: "thread-1" });
    manager = new SubagentManager(backend, sendMessage, createThread);

    // Default mock events
    mockEvents = [
      { type: "start" },
      { type: "message", content: "Hello from sub-agent" },
      { type: "done", exitCode: 0 },
    ];

    // Mock backend.spawn to return our test events
    vi.spyOn(backend, "spawn").mockImplementation(async function* () {
      for (const event of mockEvents) {
        yield event;
      }
    });
  });

  function makeTask(overrides?: Partial<SubagentTask>): SubagentTask {
    return {
      id: "task-1",
      agent: "claude",
      prompt: "do something",
      cwd: "/tmp",
      channelId: "channel-1",
      ...overrides,
    };
  }

  describe("spawn", () => {
    it("spawns a sub-agent and returns a result", async () => {
      const result = await manager.spawn(makeTask());

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("Hello from sub-agent");
    });

    it("sends start message to Discord", async () => {
      await manager.spawn(makeTask());

      // First call is the start message
      expect(sendMessage).toHaveBeenCalledWith(
        "channel-1",
        expect.stringContaining("Starting sub-agent"),
      );
    });

    it("creates a thread when useThread is true (default)", async () => {
      await manager.spawn(makeTask());

      expect(createThread).toHaveBeenCalledWith(
        "channel-1",
        expect.any(String),
        "msg-1",
      );
    });

    it("does not create a thread when useThread is false", async () => {
      await manager.spawn(makeTask({ useThread: false }));

      expect(createThread).not.toHaveBeenCalled();
    });

    it("sends events to Discord", async () => {
      await manager.spawn(makeTask());

      // Should have: start message, message event content, finish summary
      // start + thread creation counts as calls, then message event, then finish
      expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("includes agent name in start message", async () => {
      await manager.spawn(makeTask({ agent: "codex" }));

      expect(sendMessage).toHaveBeenCalledWith(
        "channel-1",
        expect.stringContaining("codex"),
      );
    });

    it("includes prompt prefix in start message", async () => {
      await manager.spawn(makeTask({ prompt: "write unit tests for auth module" }));

      expect(sendMessage).toHaveBeenCalledWith(
        "channel-1",
        expect.stringContaining("write unit tests for auth module"),
      );
    });

    it("truncates long prompts in start message", async () => {
      const longPrompt = "x".repeat(200);
      await manager.spawn(makeTask({ prompt: longPrompt }));

      expect(sendMessage).toHaveBeenCalledWith(
        "channel-1",
        expect.stringContaining("..."),
      );
    });

    it("passes spawn options to backend", async () => {
      const spawnSpy = vi.spyOn(backend, "spawn");

      await manager.spawn(
        makeTask({
          model: "fast-model",
          approveAll: false,
          timeout: 120,
          maxTurns: 5,
        }),
      );

      expect(spawnSpy).toHaveBeenCalledWith("task-1", {
        agent: "claude",
        prompt: "do something",
        cwd: "/tmp",
        model: "fast-model",
        approveAll: false,
        timeout: 120,
        maxTurns: 5,
      });
    });

    it("handles errors from backend gracefully", async () => {
      vi.spyOn(backend, "spawn").mockImplementation(async function* () {
        yield { type: "start" as const };
        throw new Error("Backend crashed");
      });

      const result = await manager.spawn(makeTask());

      expect(result.success).toBe(false);
      expect(result.error).toContain("Backend crashed");
    });

    it("sends error events to Discord", async () => {
      mockEvents = [
        { type: "start" },
        { type: "error", error: "Permission denied" },
        { type: "done", exitCode: 1 },
      ];

      await manager.spawn(makeTask());

      // Check that error content was sent
      const calls = sendMessage.mock.calls.map((c: unknown[]) => c[1] as string);
      const errorCall = calls.find((c: string) => c.includes("Permission denied"));
      expect(errorCall).toBeDefined();
    });

    it("sends tool call events when showToolCalls is true (default)", async () => {
      mockEvents = [
        { type: "start" },
        { type: "tool_use", toolName: "shell" },
        { type: "tool_result", toolName: "shell", toolResult: "OK" },
        { type: "done", exitCode: 0 },
      ];

      await manager.spawn(makeTask());

      const calls = sendMessage.mock.calls.map((c: unknown[]) => c[1] as string);
      const toolCall = calls.find((c: string) => c.includes("shell"));
      expect(toolCall).toBeDefined();
    });

    it("hides tool call events when showToolCalls is false", async () => {
      mockEvents = [
        { type: "start" },
        { type: "tool_use", toolName: "shell" },
        { type: "tool_result", toolName: "shell", toolResult: "OK" },
        { type: "done", exitCode: 0 },
      ];

      await manager.spawn(makeTask({ showToolCalls: false }));

      // After thread creation, the tool events should not generate messages
      // Filter out start/finish messages
      const threadCalls = sendMessage.mock.calls.filter(
        (c: unknown[]) => c[0] === "thread-1",
      );
      const toolCalls = threadCalls.filter((c: unknown[]) =>
        (c[1] as string).includes("shell"),
      );
      expect(toolCalls).toHaveLength(0);
    });

    it("sends completion summary", async () => {
      await manager.spawn(makeTask());

      const lastCall = sendMessage.mock.calls[sendMessage.mock.calls.length - 1];
      expect(lastCall[1]).toContain("Completed");
    });

    it("sends failure summary when task fails", async () => {
      mockEvents = [
        { type: "start" },
        { type: "done", exitCode: 1 },
      ];

      await manager.spawn(makeTask());

      const lastCall = sendMessage.mock.calls[sendMessage.mock.calls.length - 1];
      expect(lastCall[1]).toContain("Failed");
    });

    it("collects all events in result", async () => {
      mockEvents = [
        { type: "start" },
        { type: "message", content: "a" },
        { type: "tool_use", toolName: "shell" },
        { type: "tool_result", toolName: "shell", toolResult: "b" },
        { type: "message", content: "c" },
        { type: "done", exitCode: 0 },
      ];

      const result = await manager.spawn(makeTask());

      expect(result.events).toHaveLength(6);
      expect(result.output).toBe("a\nc");
    });
  });

  describe("cancel", () => {
    it("delegates to backend.cancel", () => {
      const cancelSpy = vi.spyOn(backend, "cancel").mockReturnValue(true);

      const result = manager.cancel("task-1");

      expect(cancelSpy).toHaveBeenCalledWith("task-1");
      expect(result).toBe(true);
    });

    it("returns false for unknown tasks", () => {
      const result = manager.cancel("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("isRunning", () => {
    it("delegates to backend.isRunning", () => {
      const spy = vi.spyOn(backend, "isRunning").mockReturnValue(true);

      const result = manager.isRunning("task-1");

      expect(spy).toHaveBeenCalledWith("task-1");
      expect(result).toBe(true);
    });
  });

  describe("activeCount", () => {
    it("delegates to backend.activeCount", () => {
      expect(manager.activeCount).toBe(0);
    });
  });

  describe("cancelAll", () => {
    it("delegates to backend.cancelAll", () => {
      const spy = vi.spyOn(backend, "cancelAll");

      manager.cancelAll();

      expect(spy).toHaveBeenCalled();
    });
  });
});
