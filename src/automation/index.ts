// src/automation/index.ts — Barrel exports for the automation module

export {
  parseCronExpression,
  getNextRun,
  matchesCron,
} from "./cron-parser.js";
export type { CronSchedule } from "./cron-parser.js";

export { CronScheduler } from "./cron-job.js";
export type {
  CronJob,
  CronAction,
  CronJobCallback,
  CronJobInput,
} from "./cron-job.js";

export { HeartbeatManager } from "./heartbeat.js";
export type {
  HeartbeatConfig,
  HeartbeatManagerOptions,
  RunAgentLoop,
} from "./heartbeat.js";
