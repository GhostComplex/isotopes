// src/automation/types.ts — Cron + heartbeat config types

/** Action to perform when a cron job triggers. */
export type CronAction =
  | { type: "message"; content: string }
  | { type: "prompt"; prompt: string };

/** Channel binding for a scheduled job (cron / heartbeat). */
export interface CronChannelConfig {
  accountId: string;
  channelId: string;
  threadId?: string;
  /**
   * Recent messages to prepend as context. 0 = no read. Optional in YAML;
   * `loadConfig` fills in the default (25), so downstream code can rely on it.
   */
  readLast?: number;
}
