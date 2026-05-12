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
 * Manages cron-based scheduled tasks. Each registered job's expression is
 * parsed by croner; the scheduler maintains a setTimeout per enabled job and
 * re-schedules after each trigger. Subscribe via `onTrigger`.
 */
export class CronScheduler {
  private jobs: Map<string, CronJob> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private handlers: CronJobCallback[] = [];
  private running = false;

  register(input: CronJobInput): CronJob {
    const schedule = new Cron(input.expression, { paused: true });
    const now = new Date();
    const nextRun = input.enabled ? schedule.nextRun(now) ?? undefined : undefined;

    const job: CronJob = {
      ...input,
      id: randomUUID(),
      schedule,
      nextRun,
      createdAt: now,
    };

    this.jobs.set(job.id, job);
    log.info(`Registered cron job "${job.name}" (${job.id}): ${job.expression}`);

    if (this.running && job.enabled) {
      this.scheduleTimer(job);
    }

    return job;
  }

  /** Returns true if the job existed and was removed. */
  unregister(jobId: string): boolean {
    const existed = this.jobs.has(jobId);
    if (existed) {
      this.clearTimer(jobId);
      this.jobs.delete(jobId);
      log.info(`Unregistered cron job ${jobId}`);
    }
    return existed;
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

  /** Schedules timers for all enabled jobs. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;

    for (const job of this.jobs.values()) {
      if (job.enabled) {
        job.nextRun = job.schedule.nextRun() ?? undefined;
        this.scheduleTimer(job);
      }
    }

    log.info(`Cron scheduler started with ${this.jobs.size} job(s)`);
  }

  /** Clears all timers but preserves job registrations. Idempotent. */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    for (const jobId of this.timers.keys()) {
      this.clearTimer(jobId);
    }

    log.info("Cron scheduler stopped");
  }

  private scheduleTimer(job: CronJob): void {
    this.clearTimer(job.id);

    if (!job.nextRun) return;

    const delay = Math.max(0, job.nextRun.getTime() - Date.now());

    const timer = setTimeout(() => {
      void this.triggerJob(job);
    }, delay);

    // Prevent the timer from keeping the process alive.
    if (timer.unref) timer.unref();

    this.timers.set(job.id, timer);
  }

  private clearTimer(jobId: string): void {
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }
  }

  private async triggerJob(job: CronJob): Promise<void> {
    log.info(`Triggering cron job "${job.name}" (${job.id})`);

    job.lastRun = new Date();

    for (const handler of this.handlers) {
      try {
        await handler(job);
      } catch (err) {
        log.error(`Error in cron handler for job "${job.name}":`, err);
      }
    }

    if (this.running && job.enabled) {
      job.nextRun = job.schedule.nextRun(job.lastRun) ?? undefined;
      this.scheduleTimer(job);
    }
  }
}
