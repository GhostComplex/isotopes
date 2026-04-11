// src/automation/heartbeat.test.ts — Unit tests for heartbeat manager

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HeartbeatManager, type RunAgentLoop } from "./heartbeat.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal in-memory fake for the workspace filesystem. */
function createFakeFs(files: Record<string, string> = {}) {
  return {
    readFile: vi.fn(async (filePath: unknown) => {
      // Normalize to just the filename for matching
      const filename = String(filePath).split("/").pop()!;
      if (filename in files) return files[filename];
      const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }),
  };
}

// We mock fs/promises at module level so HeartbeatManager picks it up
vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(),
  },
}));

// Suppress log output in tests
vi.mock("../core/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }),
}));

import fs from "node:fs/promises";

describe("HeartbeatManager", () => {
  let runAgentLoop: ReturnType<typeof vi.fn<RunAgentLoop>>;

  beforeEach(() => {
    vi.useFakeTimers();
    runAgentLoop = vi.fn<RunAgentLoop>().mockResolvedValue("[NO_REPLY]");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeManager(overrides?: {
    intervalSeconds?: number;
    workspacePath?: string;
  }) {
    return new HeartbeatManager({
      agentId: "test-agent",
      workspacePath: overrides?.workspacePath ?? "/workspace",
      config: {
        enabled: true,
        intervalSeconds: overrides?.intervalSeconds ?? 10,
      },
      runAgentLoop,
    });
  }

  // -----------------------------------------------------------------------
  // start / stop
  // -----------------------------------------------------------------------

  describe("start / stop", () => {
    it("starts an interval timer and stops cleanly", async () => {
      const fake = createFakeFs({ "HEARTBEAT.md": "Check things" });
      vi.mocked(fs.readFile).mockImplementation(fake.readFile);

      const hb = makeManager({ intervalSeconds: 10 });
      hb.start();

      // Advance past one interval
      await vi.advanceTimersByTimeAsync(10_000);

      expect(runAgentLoop).toHaveBeenCalledTimes(1);

      hb.stop();

      // Advance more — should not fire again
      await vi.advanceTimersByTimeAsync(20_000);

      expect(runAgentLoop).toHaveBeenCalledTimes(1);
    });

    it("start is idempotent", () => {
      const hb = makeManager();
      hb.start();
      hb.start(); // should not throw or create duplicate timers
      hb.stop();
    });

    it("stop is idempotent", () => {
      const hb = makeManager();
      hb.stop(); // should not throw when not started
      hb.start();
      hb.stop();
      hb.stop(); // should not throw when already stopped
    });
  });

  // -----------------------------------------------------------------------
  // HEARTBEAT.md missing
  // -----------------------------------------------------------------------

  describe("HEARTBEAT.md missing", () => {
    it("skips with no error when HEARTBEAT.md does not exist", async () => {
      const fake = createFakeFs({}); // no files
      vi.mocked(fs.readFile).mockImplementation(fake.readFile);

      const hb = makeManager({ intervalSeconds: 5 });
      hb.start();

      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoop).not.toHaveBeenCalled();

      hb.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Prompt construction
  // -----------------------------------------------------------------------

  describe("prompt construction", () => {
    it("calls runAgentLoop with correct agentId and session key", async () => {
      const fake = createFakeFs({ "HEARTBEAT.md": "Do periodic stuff" });
      vi.mocked(fs.readFile).mockImplementation(fake.readFile);

      const hb = makeManager({ intervalSeconds: 5 });
      hb.start();

      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoop).toHaveBeenCalledTimes(1);

      const [agentId, prompt, sessionKey] = runAgentLoop.mock.calls[0];
      expect(agentId).toBe("test-agent");
      expect(sessionKey).toBe("heartbeat:test-agent");
      expect(prompt).toContain("[HEARTBEAT]");
      expect(prompt).toContain("Do periodic stuff");
      expect(prompt).toContain("NO_REPLY");
    });

    it("includes a timestamp in the prompt", async () => {
      vi.setSystemTime(new Date("2025-06-15T10:00:00.000Z"));

      const fake = createFakeFs({ "HEARTBEAT.md": "tasks" });
      vi.mocked(fs.readFile).mockImplementation(fake.readFile);

      const hb = makeManager({ intervalSeconds: 5 });
      hb.start();

      await vi.advanceTimersByTimeAsync(5_000);

      const prompt = runAgentLoop.mock.calls[0][1];
      expect(prompt).toContain("2025-06-15T10:00:05");

      hb.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Concurrency guard
  // -----------------------------------------------------------------------

  describe("concurrency guard", () => {
    it("skips tick if previous heartbeat is still running", async () => {
      const fake = createFakeFs({ "HEARTBEAT.md": "Check things" });
      vi.mocked(fs.readFile).mockImplementation(fake.readFile);

      // Make runAgentLoop take a long time (never resolves during test)
      let resolveFirst!: (value: string) => void;
      runAgentLoop.mockImplementationOnce(
        () => new Promise<string>((resolve) => { resolveFirst = resolve; }),
      );

      const hb = makeManager({ intervalSeconds: 5 });
      hb.start();

      // First tick starts the long-running heartbeat
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runAgentLoop).toHaveBeenCalledTimes(1);

      // Second tick fires while first is still running — should skip
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runAgentLoop).toHaveBeenCalledTimes(1);

      // Resolve the first heartbeat
      resolveFirst("[NO_REPLY]");
      await vi.advanceTimersByTimeAsync(0); // flush microtasks

      // Third tick should now work
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runAgentLoop).toHaveBeenCalledTimes(2);

      hb.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Manual trigger
  // -----------------------------------------------------------------------

  describe("trigger()", () => {
    it("runs a heartbeat immediately without waiting for interval", async () => {
      const fake = createFakeFs({ "HEARTBEAT.md": "Manual check" });
      vi.mocked(fs.readFile).mockImplementation(fake.readFile);

      const hb = makeManager({ intervalSeconds: 300 });

      // Don't start the timer — just trigger manually
      await hb.trigger();

      expect(runAgentLoop).toHaveBeenCalledTimes(1);
      expect(runAgentLoop.mock.calls[0][1]).toContain("Manual check");
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("recovers from runAgentLoop errors and allows next tick", async () => {
      const fake = createFakeFs({ "HEARTBEAT.md": "Check things" });
      vi.mocked(fs.readFile).mockImplementation(fake.readFile);

      runAgentLoop.mockRejectedValueOnce(new Error("agent crashed"));
      runAgentLoop.mockResolvedValueOnce("[NO_REPLY]");

      const hb = makeManager({ intervalSeconds: 5 });
      hb.start();

      // First tick — errors
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runAgentLoop).toHaveBeenCalledTimes(1);

      // Second tick — should still fire (isRunning reset in finally)
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runAgentLoop).toHaveBeenCalledTimes(2);

      hb.stop();
    });

    it("recovers from fs read errors other than ENOENT", async () => {
      vi.mocked(fs.readFile).mockRejectedValueOnce(new Error("permission denied"));
      vi.mocked(fs.readFile).mockResolvedValueOnce("Recovered tasks");

      const hb = makeManager({ intervalSeconds: 5 });
      hb.start();

      // First tick — fs error, should not call agent
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runAgentLoop).not.toHaveBeenCalled();

      // Second tick — works
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runAgentLoop).toHaveBeenCalledTimes(1);

      hb.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Default interval
  // -----------------------------------------------------------------------

  describe("defaults", () => {
    it("uses 300 seconds when intervalSeconds is not specified", async () => {
      const fake = createFakeFs({ "HEARTBEAT.md": "tasks" });
      vi.mocked(fs.readFile).mockImplementation(fake.readFile);

      const hb = new HeartbeatManager({
        agentId: "test-agent",
        workspacePath: "/workspace",
        config: { enabled: true },
        runAgentLoop,
      });

      hb.start();

      // Should not fire at 299 seconds
      await vi.advanceTimersByTimeAsync(299_000);
      expect(runAgentLoop).not.toHaveBeenCalled();

      // Should fire at 300 seconds
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runAgentLoop).toHaveBeenCalledTimes(1);

      hb.stop();
    });
  });
});
