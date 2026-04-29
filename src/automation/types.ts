// src/automation/types.ts — Cron + heartbeat config types

/** Action to perform when a config-level cron job triggers. */
export type CronActionConfig =
  | { type: "message"; content: string }
  | { type: "prompt"; prompt: string }
  | { type: "callback"; handler: string };
