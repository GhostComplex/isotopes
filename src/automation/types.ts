// src/automation/types.ts — Cron + heartbeat config types

export interface NotificationTargetConfig {
  enabled?: boolean;
  type?: "discord";
  accountId?: string;
  channelId?: string;
  threadId?: string;
}

/** Action to perform when a cron job triggers. */
export type CronAction =
  | { type: "message"; content: string }
  | { type: "prompt"; prompt: string };
