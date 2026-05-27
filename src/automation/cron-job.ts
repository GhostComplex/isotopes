import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import type { CronAction } from "./types.js";

export type { CronAction };

/** A registered cron job with its parsed schedule and execution state. */
export interface CronJob {
  id: string;
  name: string;
  expression: string;
  schedule: Cron;
  agentId: string;
  action: CronAction;
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
  createdAt: Date;
}

/** What the scheduler does when a job fires — typically a gateway.dispatch. */
export type CronJobDispatcher = (job: CronJob) => Promise<void>;

/** Input for registering a new cron job — auto-generated fields are omitted. */
export type CronJobInput = Omit<CronJob, "id" | "schedule" | "nextRun" | "createdAt">;

/**
 * Manages cron-based scheduled tasks. croner owns the per-job timer + schedule
 * computation; this scheduler holds the registry and invokes the supplied
 * dispatcher on each fire.
 */
export class CronScheduler {
  /** jobId (UUID) → registered job. */
  private jobs: Map<string, CronJob> = new Map();
  private running = false;

  constructor(private readonly dispatchJob: CronJobDispatcher) {}

  register(input: CronJobInput): CronJob {
    const job: CronJob = {
      ...input,
      id: randomUUID(),
      schedule: undefined as unknown as Cron, // assigned below
      nextRun: undefined,
      createdAt: new Date(),
    };

    const startPaused = !this.running || !input.enabled;
    job.schedule = new Cron(
      input.expression,
      // protect: true → if a fire arrives while previous handler still running,
      //   skip it. Equivalent to the heartbeat-style "skip not stack" semantics.
      // unref: true → don't let croner's internal timer block process exit
      //   (matches the old `timer.unref()` we used to call directly).
      { paused: startPaused, protect: true, unref: true },
      async () => {
        job.lastRun = new Date();
        job.nextRun = job.schedule.nextRun() ?? undefined;
        try {
          await this.dispatchJob(job);
        } catch { /* ignore */ }
      },
    );

    if (input.enabled) {
      job.nextRun = job.schedule.nextRun() ?? undefined;
    }

    this.jobs.set(job.id, job);

    return job;
  }

  /** Returns true if the job existed and was removed. */
  unregister(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    // croner's stop() is permanent + idempotent — any in-flight handler
    // finishes naturally but croner won't fire this job again.
    job.schedule.stop();
    this.jobs.delete(jobId);
    return true;
  }

  listJobs(): CronJob[] {
    return [...this.jobs.values()];
  }

  /** Resumes all enabled jobs. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;

    for (const job of this.jobs.values()) {
      if (job.enabled) {
        job.schedule.resume();
        job.nextRun = job.schedule.nextRun() ?? undefined;
      }
    }

  }

  /** Pauses all jobs but preserves their registrations. Idempotent. */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    for (const job of this.jobs.values()) {
      job.schedule.pause();
      job.nextRun = undefined;
    }

  }
}
