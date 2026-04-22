// src/automation/cron-job.ts — Cron job scheduler for Isotopes
// Manages cron-based scheduled tasks for agents and channels.

import { Cron } from "croner";
import { createLogger } from "../core/logger.js";

const log = createLogger("cron");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Action to execute when a cron job triggers. */
export type CronAction =
  | { type: "message"; content: string }
  | { type: "prompt"; prompt: string }
  | { type: "callback"; handler: string };

/** A registered cron job with its parsed schedule and execution state. */
export interface CronJob {
  id: string;
  name: string;
  expression: string;
  schedule: Cron;
  agentId: string;
  channelId?: string;
  action: CronAction;
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
  createdAt: Date;
}

/** Callback invoked when a cron job triggers. */
export type CronJobCallback = (job: CronJob) => void | Promise<void>;

/**
 * Input for registering a new cron job.
 * Fields that are auto-generated (id, schedule, nextRun, createdAt) are omitted.
 */
export type CronJobInput = Omit<CronJob, "id" | "schedule" | "nextRun" | "createdAt">;

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let idCounter = 0;

function generateId(): string {
  return `cron_${Date.now()}_${++idCounter}`;
}

// ---------------------------------------------------------------------------
// CronScheduler
// ---------------------------------------------------------------------------

/**
 * CronScheduler — manages cron-based scheduled tasks.
 *
 * Jobs are registered with a cron expression that is parsed into a
 * {@link Cron}. When the scheduler is started, it sets timers
 * for each enabled job and re-schedules them after every trigger.
 * Callbacks registered via {@link onTrigger} are invoked each time a
 * job fires.
 */
export class CronScheduler {
  private jobs: Map<string, CronJob> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private handlers: CronJobCallback[] = [];
  private running = false;

  /**
   * Register a new cron job.
   * Parses the cron expression and schedules the next run if the scheduler is started.
   */
  register(input: CronJobInput): CronJob {
    const schedule = new Cron(input.expression, { paused: true });
    const now = new Date();
    const nextRun = input.enabled ? schedule.nextRun(now) ?? undefined : undefined;

    const job: CronJob = {
      ...input,
      id: generateId(),
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

  /**
   * Unregister a cron job by ID. Clears its timer if running.
   * Returns true if the job existed and was removed.
   */
  unregister(jobId: string): boolean {
    const existed = this.jobs.has(jobId);
    if (existed) {
      this.clearTimer(jobId);
      this.jobs.delete(jobId);
      log.info(`Unregistered cron job ${jobId}`);
    }
    return existed;
  }

  /**
   * Enable a cron job. If the scheduler is running, schedules its next timer.
   * Returns true if the job exists and was enabled.
   */
  enable(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    job.enabled = true;
    job.nextRun = job.schedule.nextRun() ?? undefined;

    if (this.running) {
      this.scheduleTimer(job);
    }

    log.info(`Enabled cron job "${job.name}" (${jobId})`);
    return true;
  }

  /**
   * Disable a cron job. Clears its timer.
   * Returns true if the job exists and was disabled.
   */
  disable(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    job.enabled = false;
    job.nextRun = undefined;
    this.clearTimer(jobId);

    log.info(`Disabled cron job "${job.name}" (${jobId})`);
    return true;
  }

  /**
   * Get a job by ID.
   */
  getJob(jobId: string): CronJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * List jobs with optional filtering.
   */
  listJobs(filter?: { agentId?: string; enabled?: boolean }): CronJob[] {
    let jobs = [...this.jobs.values()];

    if (filter?.agentId !== undefined) {
      jobs = jobs.filter((j) => j.agentId === filter.agentId);
    }
    if (filter?.enabled !== undefined) {
      jobs = jobs.filter((j) => j.enabled === filter.enabled);
    }

    return jobs;
  }

  /**
   * Register a callback to be invoked when any cron job triggers.
   * Returns an unsubscribe function.
   */
  onTrigger(callback: CronJobCallback): () => void {
    this.handlers.push(callback);
    return () => {
      const idx = this.handlers.indexOf(callback);
      if (idx !== -1) this.handlers.splice(idx, 1);
    };
  }

  /**
   * Start the scheduler. Schedules timers for all enabled jobs.
   */
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

  /**
   * Stop the scheduler. Clears all timers but preserves job registrations.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    for (const jobId of this.timers.keys()) {
      this.clearTimer(jobId);
    }

    log.info("Cron scheduler stopped");
  }

  // -----------------------------------------------------------------------
  // Internal scheduling
  // -----------------------------------------------------------------------

  private scheduleTimer(job: CronJob): void {
    this.clearTimer(job.id);

    if (!job.nextRun) return;

    const delay = Math.max(0, job.nextRun.getTime() - Date.now());

    const timer = setTimeout(() => {
      void this.triggerJob(job);
    }, delay);

    // Prevent the timer from keeping the process alive
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

    // Notify all handlers
    for (const handler of this.handlers) {
      try {
        await handler(job);
      } catch (err) {
        log.error(`Error in cron handler for job "${job.name}":`, err);
      }
    }

    // Schedule next run
    if (this.running && job.enabled) {
      job.nextRun = job.schedule.nextRun(job.lastRun) ?? undefined;
      this.scheduleTimer(job);
    }
  }
}
