// src/automation/cron-job.test.ts — Unit tests for cron job scheduler

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CronScheduler, type CronJobInput } from "./cron-job.js";

describe("CronScheduler", () => {
  let scheduler: CronScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new CronScheduler();
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Helper to create a simple job input
  // -----------------------------------------------------------------------

  function makeJobInput(overrides?: Partial<CronJobInput>): CronJobInput {
    return {
      name: "test-job",
      expression: "0 9 * * 1-5",
      agentId: "agent-1",
      action: { type: "message", content: "Good morning!" },
      enabled: true,
      ...overrides,
    };
  }

  // -----------------------------------------------------------------------
  // register
  // -----------------------------------------------------------------------

  describe("register", () => {
    it("creates a job with an auto-generated ID", () => {
      const job = scheduler.register(makeJobInput());

      expect(job.id).toBeDefined();
      expect(job.id).toMatch(/^cron_/);
    });

    it("parses the cron expression into a schedule", () => {
      const job = scheduler.register(makeJobInput({ expression: "*/15 * * * *" }));

      expect(job.schedule.minute).toEqual([0, 15, 30, 45]);
      expect(job.schedule.hour).toHaveLength(24);
    });

    it("computes nextRun for enabled jobs", () => {
      const job = scheduler.register(makeJobInput());

      expect(job.nextRun).toBeInstanceOf(Date);
    });

    it("does not compute nextRun for disabled jobs", () => {
      const job = scheduler.register(makeJobInput({ enabled: false }));

      expect(job.nextRun).toBeUndefined();
    });

    it("sets createdAt timestamp", () => {
      const before = new Date();
      const job = scheduler.register(makeJobInput());

      expect(job.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it("preserves all input fields", () => {
      const input = makeJobInput({
        name: "standup",
        agentId: "agent-2",
        channelId: "channel-1",
        action: { type: "prompt", prompt: "Run standup" },
      });
      const job = scheduler.register(input);

      expect(job.name).toBe("standup");
      expect(job.agentId).toBe("agent-2");
      expect(job.channelId).toBe("channel-1");
      expect(job.action).toEqual({ type: "prompt", prompt: "Run standup" });
    });

    it("throws on invalid cron expression", () => {
      expect(() =>
        scheduler.register(makeJobInput({ expression: "bad expression" })),
      ).toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // unregister
  // -----------------------------------------------------------------------

  describe("unregister", () => {
    it("removes an existing job", () => {
      const job = scheduler.register(makeJobInput());

      const removed = scheduler.unregister(job.id);

      expect(removed).toBe(true);
      expect(scheduler.getJob(job.id)).toBeUndefined();
    });

    it("returns false for non-existent job", () => {
      const removed = scheduler.unregister("nonexistent");

      expect(removed).toBe(false);
    });

    it("is not listed after removal", () => {
      const job = scheduler.register(makeJobInput());
      scheduler.unregister(job.id);

      expect(scheduler.listJobs()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // enable / disable
  // -----------------------------------------------------------------------

  describe("enable", () => {
    it("enables a disabled job", () => {
      const job = scheduler.register(makeJobInput({ enabled: false }));

      const result = scheduler.enable(job.id);

      expect(result).toBe(true);
      expect(scheduler.getJob(job.id)!.enabled).toBe(true);
      expect(scheduler.getJob(job.id)!.nextRun).toBeInstanceOf(Date);
    });

    it("returns false for non-existent job", () => {
      expect(scheduler.enable("nonexistent")).toBe(false);
    });
  });

  describe("disable", () => {
    it("disables an enabled job", () => {
      const job = scheduler.register(makeJobInput({ enabled: true }));

      const result = scheduler.disable(job.id);

      expect(result).toBe(true);
      expect(scheduler.getJob(job.id)!.enabled).toBe(false);
      expect(scheduler.getJob(job.id)!.nextRun).toBeUndefined();
    });

    it("returns false for non-existent job", () => {
      expect(scheduler.disable("nonexistent")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // getJob
  // -----------------------------------------------------------------------

  describe("getJob", () => {
    it("returns the job if it exists", () => {
      const job = scheduler.register(makeJobInput());

      expect(scheduler.getJob(job.id)).toBe(job);
    });

    it("returns undefined for unknown ID", () => {
      expect(scheduler.getJob("unknown")).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // listJobs
  // -----------------------------------------------------------------------

  describe("listJobs", () => {
    it("lists all registered jobs", () => {
      scheduler.register(makeJobInput({ name: "job1" }));
      scheduler.register(makeJobInput({ name: "job2" }));

      expect(scheduler.listJobs()).toHaveLength(2);
    });

    it("filters by agentId", () => {
      scheduler.register(makeJobInput({ name: "a1", agentId: "agent-1" }));
      scheduler.register(makeJobInput({ name: "a2", agentId: "agent-2" }));
      scheduler.register(makeJobInput({ name: "a3", agentId: "agent-1" }));

      const filtered = scheduler.listJobs({ agentId: "agent-1" });

      expect(filtered).toHaveLength(2);
      expect(filtered.every((j) => j.agentId === "agent-1")).toBe(true);
    });

    it("filters by enabled state", () => {
      scheduler.register(makeJobInput({ name: "enabled", enabled: true }));
      scheduler.register(makeJobInput({ name: "disabled", enabled: false }));

      expect(scheduler.listJobs({ enabled: true })).toHaveLength(1);
      expect(scheduler.listJobs({ enabled: false })).toHaveLength(1);
    });

    it("filters by both agentId and enabled", () => {
      scheduler.register(makeJobInput({ agentId: "a1", enabled: true }));
      scheduler.register(makeJobInput({ agentId: "a1", enabled: false }));
      scheduler.register(makeJobInput({ agentId: "a2", enabled: true }));

      const filtered = scheduler.listJobs({ agentId: "a1", enabled: true });

      expect(filtered).toHaveLength(1);
    });

    it("returns empty array when no jobs match", () => {
      scheduler.register(makeJobInput({ agentId: "agent-1" }));

      expect(scheduler.listJobs({ agentId: "nonexistent" })).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // onTrigger / callback execution
  // -----------------------------------------------------------------------

  describe("onTrigger", () => {
    it("calls registered callbacks when a job fires", async () => {
      const callback = vi.fn();
      scheduler.onTrigger(callback);

      // Set time to just before the next trigger
      vi.setSystemTime(new Date(2025, 3, 7, 8, 59, 0)); // Monday 8:59 AM

      // Register a job that fires at 9:00 AM weekdays
      const job = scheduler.register(makeJobInput({ expression: "0 9 * * 1-5" }));
      scheduler.start();

      // Advance time past the trigger
      await vi.advanceTimersByTimeAsync(60_000 + 1);

      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    });

    it("calls multiple callbacks", async () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      scheduler.onTrigger(cb1);
      scheduler.onTrigger(cb2);

      vi.setSystemTime(new Date(2025, 3, 7, 8, 59, 0));

      scheduler.register(makeJobInput({ expression: "0 9 * * 1-5" }));
      scheduler.start();

      await vi.advanceTimersByTimeAsync(60_000 + 1);

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it("unsubscribe removes the callback", async () => {
      const callback = vi.fn();
      const unsub = scheduler.onTrigger(callback);
      unsub();

      vi.setSystemTime(new Date(2025, 3, 7, 8, 59, 0));

      scheduler.register(makeJobInput({ expression: "0 9 * * 1-5" }));
      scheduler.start();

      await vi.advanceTimersByTimeAsync(60_000 + 1);

      expect(callback).not.toHaveBeenCalled();
    });

    it("handles errors in callbacks without stopping other callbacks", async () => {
      const badCallback = vi.fn().mockRejectedValue(new Error("handler error"));
      const goodCallback = vi.fn();

      scheduler.onTrigger(badCallback);
      scheduler.onTrigger(goodCallback);

      vi.setSystemTime(new Date(2025, 3, 7, 8, 59, 0));

      scheduler.register(makeJobInput({ expression: "0 9 * * 1-5" }));
      scheduler.start();

      await vi.advanceTimersByTimeAsync(60_000 + 1);

      expect(badCallback).toHaveBeenCalledTimes(1);
      expect(goodCallback).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // start / stop
  // -----------------------------------------------------------------------

  describe("start / stop", () => {
    it("start is idempotent", () => {
      scheduler.start();
      scheduler.start(); // should not throw

      expect(scheduler.listJobs()).toHaveLength(0);
    });

    it("stop is idempotent", () => {
      scheduler.stop();
      scheduler.stop(); // should not throw
    });

    it("does not fire jobs after stop", async () => {
      const callback = vi.fn();
      scheduler.onTrigger(callback);

      vi.setSystemTime(new Date(2025, 3, 7, 8, 59, 0));

      scheduler.register(makeJobInput({ expression: "0 9 * * 1-5" }));
      scheduler.start();
      scheduler.stop();

      await vi.advanceTimersByTimeAsync(120_000);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Job state after trigger
  // -----------------------------------------------------------------------

  describe("job state after trigger", () => {
    it("updates lastRun after firing", async () => {
      vi.setSystemTime(new Date(2025, 3, 7, 8, 59, 0));

      const job = scheduler.register(makeJobInput({ expression: "0 9 * * 1-5" }));
      expect(job.lastRun).toBeUndefined();

      scheduler.onTrigger(() => {}); // no-op handler
      scheduler.start();

      await vi.advanceTimersByTimeAsync(60_000 + 1);

      const updated = scheduler.getJob(job.id)!;
      expect(updated.lastRun).toBeInstanceOf(Date);
    });

    it("schedules the next run after firing", async () => {
      vi.setSystemTime(new Date(2025, 3, 7, 8, 59, 0));

      const job = scheduler.register(makeJobInput({ expression: "0 9 * * 1-5" }));
      const firstNextRun = job.nextRun!.getTime();

      scheduler.onTrigger(() => {});
      scheduler.start();

      await vi.advanceTimersByTimeAsync(60_000 + 1);

      const updated = scheduler.getJob(job.id)!;
      expect(updated.nextRun).toBeInstanceOf(Date);
      expect(updated.nextRun!.getTime()).toBeGreaterThan(firstNextRun);
    });
  });

  // -----------------------------------------------------------------------
  // Different action types
  // -----------------------------------------------------------------------

  describe("action types", () => {
    it("registers message action", () => {
      const job = scheduler.register(
        makeJobInput({ action: { type: "message", content: "Hello!" } }),
      );
      expect(job.action).toEqual({ type: "message", content: "Hello!" });
    });

    it("registers prompt action", () => {
      const job = scheduler.register(
        makeJobInput({ action: { type: "prompt", prompt: "Run report" } }),
      );
      expect(job.action).toEqual({ type: "prompt", prompt: "Run report" });
    });

    it("registers callback action", () => {
      const job = scheduler.register(
        makeJobInput({ action: { type: "callback", handler: "generateReport" } }),
      );
      expect(job.action).toEqual({ type: "callback", handler: "generateReport" });
    });
  });
});
