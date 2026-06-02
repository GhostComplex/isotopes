// src/automation/types.ts — Cron + heartbeat config types

/** Action to perform when a cron job triggers. */
export type CronAction =
  | { type: "message"; content: string }
  | { type: "prompt"; prompt: string };

export interface CronChannelConfig {
  accountId: string;
  channelId: string;
  threadId?: string;
  /** Recent messages to prepend. 0 = no read; omitted = 25 (filled by loadConfig). */
  readLast?: number;
}
