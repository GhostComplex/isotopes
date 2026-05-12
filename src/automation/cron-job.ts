import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import { createLogger } from "../logging/logger.js";
import type { CronAction } from "./types.js";

export type { CronAction };

const log = createLogger("cron");

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

export type CronJobCallback = (job: CronJob) => void | Promise<void>;

/** Input for registering a new cron job — auto-generated fields are omitted. */
export type CronJobInput = Omit<CronJob, "id" | "schedule" | "nextRun" | "createdAt">;

/**
 * Manages cron-based scheduled tasks. croner owns the per-job timer + schedule
 * computation; this scheduler holds the registry and a list of trigger handlers
 * to fan-out invocations to. Subscribe via `onTrigger`.
 */
export class CronScheduler {
  /** jobId (UUID) → registered job. */
  private jobs: Map<string, CronJob> = new Map();
  private handlers: CronJobCallback[] = [];
  private running = false;

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
      // skip it. Equivalent to the heartbeat-style "skip not stack" semantics.
      { paused: startPaused, protect: true },
      async () => {
        log.info(`Triggering cron job "${job.name}" (${job.id})`);
        job.lastRun = new Date();
        job.nextRun = job.schedule.nextRun() ?? undefined;
        for (const handler of this.handlers) {
          try {
            await handler(job);
          } catch (err) {
            log.error(`Error in cron handler for job "${job.name}":`, err);
          }
        }
      },
    );

    if (input.enabled) {
      job.nextRun = job.schedule.nextRun() ?? undefined;
    }

    this.jobs.set(job.id, job);
    log.info(`Registered cron job "${job.name}" (${job.id}): ${job.expression}`);

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
    log.info(`Unregistered cron job ${jobId}`);
    return true;
  }

  listJobs(): CronJob[] {
    return [...this.jobs.values()];
  }

  /** Subscribe to all cron triggers. Returns an unsubscribe function. */
  onTrigger(callback: CronJobCallback): () => void {
    this.handlers.push(callback);
    return () => {
      const idx = this.handlers.indexOf(callback);
      if (idx !== -1) this.handlers.splice(idx, 1);
    };
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

    log.info(`Cron scheduler started with ${this.jobs.size} job(s)`);
  }

  /** Pauses all jobs but preserves their registrations. Idempotent. */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    for (const job of this.jobs.values()) {
      job.schedule.pause();
      job.nextRun = undefined;
    }

    log.info("Cron scheduler stopped");
  }
}
