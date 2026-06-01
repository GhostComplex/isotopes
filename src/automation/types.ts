// src/automation/types.ts — Cron + heartbeat config types

import type { ChannelTarget } from "../channels/types.js";

/** Action to perform when a cron job triggers. */
export type CronAction =
  | { type: "message"; content: string }
  | { type: "prompt"; prompt: string };

/** Destination for the final response of a scheduled run. */
export type DeliveryTarget = ChannelTarget;
