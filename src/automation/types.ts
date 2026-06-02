// src/automation/types.ts — Cron + heartbeat config types

/** Action to perform when a cron job triggers. */
export type CronAction =
  | { type: "message"; content: string }
  | { type: "prompt"; prompt: string };

/**
 * Channel binding for a scheduled job (cron / heartbeat).
 *
 * - `accountId` + `channelId` are required: identifies which bot posts and where.
 * - `threadId` posts (and reads) inside a thread; otherwise the channel itself.
 * - `readLast > 0` injects that many recent messages into the prompt before
 *   dispatch; 0 / omitted leaves the prompt untouched.
 */
export interface CronChannelConfig {
  accountId: string;
  channelId: string;
  threadId?: string;
  readLast?: number;
}
