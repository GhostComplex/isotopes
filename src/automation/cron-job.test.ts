import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CronScheduler, type CronJob, type CronJobInput } from "./cron-job.js";

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

      const updated = scheduler.listJobs().find((j) => j.id === job.id)!;
      expect(updated.lastRun).toBeInstanceOf(Date);
    });

    it("schedules the next run after firing", async () => {
      vi.setSystemTime(new Date(2025, 3, 7, 8, 59, 0));

      const job = scheduler.register(makeJobInput({ expression: "0 9 * * 1-5" }));
      const firstNextRun = job.nextRun!.getTime();

      scheduler.onTrigger(() => {});
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

// ---------------------------------------------------------------------------
// Config-driven registration (#193)
// ---------------------------------------------------------------------------

describe("cron config integration (#193)", () => {
  let scheduler: CronScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new CronScheduler();
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  // Simulates the config loading pattern used in cli.ts
  interface CronTaskConfig {
    name: string;
    schedule: string;
    prompt: string;
    enabled?: boolean;
  }

  interface AgentCronConfig {
    id: string;
    cron?: { tasks: CronTaskConfig[] };
  }

  function registerFromConfig(agents: AgentCronConfig[]): void {
    for (const agent of agents) {
      if (!agent.cron?.tasks?.length) continue;
      for (const task of agent.cron.tasks) {
        scheduler.register({
          name: task.name,
          expression: task.schedule,
          agentId: agent.id,
          action: { type: "prompt", prompt: task.prompt },
          enabled: task.enabled ?? true,
        });
      }
    }
  }

  describe("registration from config", () => {
    it("registers per-agent cron tasks", () => {
      registerFromConfig([
        {
          id: "bot-1",
          cron: {
            tasks: [
              { name: "standup", schedule: "0 9 * * 1-5", prompt: "Run standup" },
              { name: "report", schedule: "0 17 * * 5", prompt: "Weekly report" },
            ],
          },
        },
      ]);

      const jobs = scheduler.listJobs();
      expect(jobs).toHaveLength(2);
      expect(jobs[0].agentId).toBe("bot-1");
      expect(jobs[0].name).toBe("standup");
      expect(jobs[1].name).toBe("report");
    });

    it("skips agents without cron config", () => {
      registerFromConfig([
        { id: "bot-1" },
        { id: "bot-2", cron: { tasks: [] } },
        {
          id: "bot-3",
          cron: {
            tasks: [{ name: "ping", schedule: "*/5 * * * *", prompt: "Ping" }],
          },
        },
      ]);

      const jobs = scheduler.listJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].agentId).toBe("bot-3");
    });

    it("defaults enabled to true when not specified", () => {
      registerFromConfig([
        {
          id: "bot-1",
          cron: {
            tasks: [
              { name: "enabled-task", schedule: "0 * * * *", prompt: "go" },
            ],
          },
        },
      ]);

      expect(scheduler.listJobs()[0].enabled).toBe(true);
    });

    it("respects enabled: false in config", () => {
      registerFromConfig([
        {
          id: "bot-1",
          cron: {
            tasks: [
              { name: "disabled-task", schedule: "0 * * * *", prompt: "go", enabled: false },
            ],
          },
        },
      ]);

      expect(scheduler.listJobs()[0].enabled).toBe(false);
      expect(scheduler.listJobs()[0].nextRun).toBeUndefined();
    });

    it("registers tasks for multiple agents", () => {
      registerFromConfig([
        {
          id: "agent-a",
          cron: { tasks: [{ name: "task-a", schedule: "0 8 * * *", prompt: "A" }] },
        },
        {
          id: "agent-b",
          cron: { tasks: [{ name: "task-b", schedule: "0 9 * * *", prompt: "B" }] },
        },
      ]);

      const jobs = scheduler.listJobs();
      expect(jobs).toHaveLength(2);
      expect(jobs.map((j) => j.agentId).sort()).toEqual(["agent-a", "agent-b"]);
    });
  });

  describe("trigger callback", () => {
    it("invokes callback with correct job when cron fires", async () => {
      vi.setSystemTime(new Date(2025, 3, 7, 8, 59, 0)); // Monday 8:59 AM

      registerFromConfig([
        {
          id: "bot-1",
          cron: {
            tasks: [{ name: "morning", schedule: "0 9 * * 1-5", prompt: "Good morning!" }],
          },
        },
      ]);

      const triggered: CronJob[] = [];
      scheduler.onTrigger((job) => { triggered.push(job); });
      scheduler.start();

      await vi.advanceTimersByTimeAsync(60_000 + 1);

      expect(triggered).toHaveLength(1);
      expect(triggered[0].name).toBe("morning");
      expect(triggered[0].agentId).toBe("bot-1");
      expect(triggered[0].action).toEqual({ type: "prompt", prompt: "Good morning!" });
    });

    it("does not trigger disabled tasks", async () => {
      vi.setSystemTime(new Date(2025, 3, 7, 8, 59, 0));

      registerFromConfig([
        {
          id: "bot-1",
          cron: {
            tasks: [{ name: "disabled", schedule: "0 9 * * 1-5", prompt: "Nope", enabled: false }],
          },
        },
      ]);

      const triggered: CronJob[] = [];
      scheduler.onTrigger((job) => { triggered.push(job); });
      scheduler.start();

      await vi.advanceTimersByTimeAsync(120_000);

      expect(triggered).toHaveLength(0);
    });

    it("triggers multiple jobs from different agents", async () => {
      vi.setSystemTime(new Date(2025, 3, 7, 8, 59, 0));

      registerFromConfig([
        {
          id: "bot-1",
          cron: {
            tasks: [{ name: "task-1", schedule: "0 9 * * 1-5", prompt: "Hi from 1" }],
          },
        },
        {
          id: "bot-2",
          cron: {
            tasks: [{ name: "task-2", schedule: "0 9 * * 1-5", prompt: "Hi from 2" }],
          },
        },
      ]);

      const triggered: string[] = [];
      scheduler.onTrigger((job) => { triggered.push(job.name); });
      scheduler.start();

      await vi.advanceTimersByTimeAsync(60_000 + 1);

      expect(triggered.sort()).toEqual(["task-1", "task-2"]);
    });
  });

  describe("lifecycle", () => {
    it("stops scheduler cleanly — no triggers after stop", async () => {
      vi.setSystemTime(new Date(2025, 3, 7, 8, 59, 0));

      registerFromConfig([
        {
          id: "bot-1",
          cron: {
            tasks: [{ name: "task", schedule: "0 9 * * 1-5", prompt: "go" }],
          },
        },
      ]);

      const triggered: CronJob[] = [];
      scheduler.onTrigger((job) => { triggered.push(job); });
      scheduler.start();
      scheduler.stop();

      await vi.advanceTimersByTimeAsync(120_000);

      expect(triggered).toHaveLength(0);
    });

    it("unregisters a config-defined job by ID", () => {
      registerFromConfig([
        {
          id: "bot-1",
          cron: {
            tasks: [{ name: "removable", schedule: "0 * * * *", prompt: "go" }],
          },
        },
      ]);

      const job = scheduler.listJobs()[0];
      scheduler.unregister(job.id);

      expect(scheduler.listJobs()).toHaveLength(0);
    });
  });
});
