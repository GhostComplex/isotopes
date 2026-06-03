import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CronScheduler, type CronJob, type CronJobInput } from "./cron-job.js";

describe("CronScheduler", () => {
  let scheduler: CronScheduler;
  let dispatcher: ReturnType<typeof vi.fn<(job: CronJob) => Promise<void>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    dispatcher = vi.fn<(job: CronJob) => Promise<void>>().mockResolvedValue(undefined);
    scheduler = new CronScheduler((job) => dispatcher(job));
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
      expect(job.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("parses the cron expression into a schedule", () => {
      const job = scheduler.register(makeJobInput({ expression: "*/15 * * * *" }));

      expect(job.schedule).toBeDefined();
      expect(job.schedule.nextRun()).toBeInstanceOf(Date);
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
        action: { type: "prompt", prompt: "Run standup" },
      });
      const job = scheduler.register(input);

      expect(job.name).toBe("standup");
      expect(job.agentId).toBe("agent-2");
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
      expect(scheduler.listJobs()).toHaveLength(0);
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
  // listJobs
  // -----------------------------------------------------------------------

  describe("listJobs", () => {
    it("lists all registered jobs", () => {
      scheduler.register(makeJobInput({ name: "job1" }));
      scheduler.register(makeJobInput({ name: "job2" }));

      expect(scheduler.listJobs()).toHaveLength(2);
    });

    it("returns empty array when no jobs registered", () => {
      expect(scheduler.listJobs()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // dispatcher invocation
  // -----------------------------------------------------------------------

  describe("dispatcher", () => {
    it("invokes the dispatcher when a job fires", async () => {
      vi.setSystemTime(new Date(2025, 3, 7, 8, 59, 0));

      const job = scheduler.register(makeJobInput({ expression: "0 9 * * 1-5" }));
      scheduler.start();

      await vi.advanceTimersByTimeAsync(60_000 + 1);

      expect(dispatcher).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    });

    it("logs and continues when the dispatcher rejects", async () => {
      dispatcher.mockRejectedValueOnce(new Error("dispatch failed"));

      vi.setSystemTime(new Date(2025, 3, 7, 8, 59, 0));

      scheduler.register(makeJobInput({ expression: "0 9 * * 1-5" }));
      scheduler.start();

      await vi.advanceTimersByTimeAsync(60_000 + 1);

      expect(dispatcher).toHaveBeenCalledTimes(1);
      // Scheduler still alive — second tick still fires.
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(dispatcher.mock.calls.length).toBeGreaterThanOrEqual(2);
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
      vi.setSystemTime(new Date(2025, 3, 7, 8, 59, 0));

      scheduler.register(makeJobInput({ expression: "0 9 * * 1-5" }));
      scheduler.start();
      scheduler.stop();

      await vi.advanceTimersByTimeAsync(120_000);

      expect(dispatcher).not.toHaveBeenCalled();
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

      scheduler.start();

      await vi.advanceTimersByTimeAsync(60_000 + 1);

      const updated = scheduler.listJobs().find((j) => j.id === job.id)!;
      expect(updated.lastRun).toBeInstanceOf(Date);
    });

    it("schedules the next run after firing", async () => {
      vi.setSystemTime(new Date(2025, 3, 7, 8, 59, 0));

      const job = scheduler.register(makeJobInput({ expression: "0 9 * * 1-5" }));
      const firstNextRun = job.nextRun!.getTime();

      scheduler.start();

      await vi.advanceTimersByTimeAsync(60_000 + 1);

      const updated = scheduler.listJobs().find((j) => j.id === job.id)!;
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
  });
});

