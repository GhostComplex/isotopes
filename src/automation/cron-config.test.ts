// src/automation/cron-config.test.ts — Tests for cron config integration (#193)
// Verifies that per-agent cron tasks from config are correctly registered,
// trigger agent prompts, and handle lifecycle (start/stop).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CronScheduler, type CronJob } from "./cron-job.js";

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

  // -----------------------------------------------------------------------
  // Simulates the config loading pattern used in cli.ts
  // -----------------------------------------------------------------------

  interface CronTaskConfig {
    name: string;
    schedule: string;
    channel: string;
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
          channelId: task.channel,
          action: { type: "prompt", prompt: task.prompt },
          enabled: task.enabled ?? true,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Registration from config
  // -----------------------------------------------------------------------

  describe("registration from config", () => {
    it("registers per-agent cron tasks", () => {
      registerFromConfig([
        {
          id: "bot-1",
          cron: {
            tasks: [
              { name: "standup", schedule: "0 9 * * 1-5", channel: "general", prompt: "Run standup" },
              { name: "report", schedule: "0 17 * * 5", channel: "reports", prompt: "Weekly report" },
            ],
          },
        },
      ]);

      const jobs = scheduler.listJobs();
      expect(jobs).toHaveLength(2);
      expect(jobs[0].agentId).toBe("bot-1");
      expect(jobs[0].name).toBe("standup");
      expect(jobs[0].channelId).toBe("general");
      expect(jobs[1].name).toBe("report");
    });

    it("skips agents without cron config", () => {
      registerFromConfig([
        { id: "bot-1" },
        { id: "bot-2", cron: { tasks: [] } },
        {
          id: "bot-3",
          cron: {
            tasks: [{ name: "ping", schedule: "*/5 * * * *", channel: "ops", prompt: "Ping" }],
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
              { name: "enabled-task", schedule: "0 * * * *", channel: "ch", prompt: "go" },
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
              { name: "disabled-task", schedule: "0 * * * *", channel: "ch", prompt: "go", enabled: false },
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
          cron: { tasks: [{ name: "task-a", schedule: "0 8 * * *", channel: "ch-a", prompt: "A" }] },
        },
        {
          id: "agent-b",
          cron: { tasks: [{ name: "task-b", schedule: "0 9 * * *", channel: "ch-b", prompt: "B" }] },
        },
      ]);

      const jobs = scheduler.listJobs();
      expect(jobs).toHaveLength(2);
      expect(jobs.map((j) => j.agentId).sort()).toEqual(["agent-a", "agent-b"]);
    });
  });

  // -----------------------------------------------------------------------
  // Trigger callback integration
  // -----------------------------------------------------------------------

  describe("trigger callback", () => {
    it("invokes callback with correct job when cron fires", async () => {
      vi.setSystemTime(new Date(2025, 3, 7, 8, 59, 0)); // Monday 8:59 AM

      registerFromConfig([
        {
          id: "bot-1",
          cron: {
            tasks: [{ name: "morning", schedule: "0 9 * * 1-5", channel: "general", prompt: "Good morning!" }],
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
      expect(triggered[0].channelId).toBe("general");
      expect(triggered[0].action).toEqual({ type: "prompt", prompt: "Good morning!" });
    });

    it("does not trigger disabled tasks", async () => {
      vi.setSystemTime(new Date(2025, 3, 7, 8, 59, 0));

      registerFromConfig([
        {
          id: "bot-1",
          cron: {
            tasks: [{ name: "disabled", schedule: "0 9 * * 1-5", channel: "ch", prompt: "Nope", enabled: false }],
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
            tasks: [{ name: "task-1", schedule: "0 9 * * 1-5", channel: "ch-1", prompt: "Hi from 1" }],
          },
        },
        {
          id: "bot-2",
          cron: {
            tasks: [{ name: "task-2", schedule: "0 9 * * 1-5", channel: "ch-2", prompt: "Hi from 2" }],
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

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  describe("lifecycle", () => {
    it("stops scheduler cleanly — no triggers after stop", async () => {
      vi.setSystemTime(new Date(2025, 3, 7, 8, 59, 0));

      registerFromConfig([
        {
          id: "bot-1",
          cron: {
            tasks: [{ name: "task", schedule: "0 9 * * 1-5", channel: "ch", prompt: "go" }],
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

    it("filters jobs by agentId after registration", () => {
      registerFromConfig([
        {
          id: "agent-a",
          cron: { tasks: [{ name: "a1", schedule: "0 * * * *", channel: "ch", prompt: "A" }] },
        },
        {
          id: "agent-b",
          cron: { tasks: [{ name: "b1", schedule: "0 * * * *", channel: "ch", prompt: "B" }] },
        },
      ]);

      const agentAJobs = scheduler.listJobs({ agentId: "agent-a" });
      expect(agentAJobs).toHaveLength(1);
      expect(agentAJobs[0].name).toBe("a1");
    });

    it("unregisters a config-defined job by ID", () => {
      registerFromConfig([
        {
          id: "bot-1",
          cron: {
            tasks: [{ name: "removable", schedule: "0 * * * *", channel: "ch", prompt: "go" }],
          },
        },
      ]);

      const job = scheduler.listJobs()[0];
      scheduler.unregister(job.id);

      expect(scheduler.listJobs()).toHaveLength(0);
    });
  });
});
