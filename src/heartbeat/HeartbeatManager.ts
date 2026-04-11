// src/heartbeat/HeartbeatManager.ts — Periodic heartbeat system for agents
// Manages per-channel heartbeat intervals, skipping beats when the channel
// has recent activity to avoid interrupting active conversations.

import { createLogger } from "../core/logger.js";

const log = createLogger("heartbeat");

/** Default prompt sent to the agent on each heartbeat tick. */
export const DEFAULT_HEARTBEAT_PROMPT =
  "This is a periodic heartbeat. Check for any pending tasks, notifications, or updates. " +
  "Reply [HEARTBEAT_OK] if nothing needs attention, or take action if needed.";

/** Callback invoked on each heartbeat tick. */
export type HeartbeatCallback = (channelId: string, agentId: string) => void | Promise<void>;

/** Internal state for a single channel's heartbeat. */
interface HeartbeatEntry {
  channelId: string;
  agentId: string;
  interval: number;
  callback: HeartbeatCallback;
  timer: ReturnType<typeof setInterval>;
  lastActivity: number;
}

/**
 * Manages periodic heartbeat timers for agent channels.
 *
 * Each channel can have at most one heartbeat. When a heartbeat fires,
 * it checks whether the channel had recent activity (within `interval / 2`).
 * If so, the beat is skipped to avoid interrupting active conversations.
 */
export class HeartbeatManager {
  private readonly entries = new Map<string, HeartbeatEntry>();

  /**
   * Start a heartbeat for a channel.
   *
   * If a heartbeat is already running for the channel it is replaced.
   *
   * @param channelId  Unique channel identifier
   * @param agentId    Agent that owns this heartbeat
   * @param interval   Interval in milliseconds between beats
   * @param callback   Function invoked on each (non-skipped) beat
   */
  startHeartbeat(
    channelId: string,
    agentId: string,
    interval: number,
    callback: HeartbeatCallback,
  ): void {
    // Replace any existing heartbeat for this channel
    this.stopHeartbeat(channelId);

    const entry: HeartbeatEntry = {
      channelId,
      agentId,
      interval,
      callback,
      lastActivity: 0,
      timer: setInterval(() => this.tick(channelId), interval),
    };

    this.entries.set(channelId, entry);
    log.info(`Heartbeat started for channel=${channelId} agent=${agentId} interval=${interval}ms`);
  }

  /** Stop and remove the heartbeat for a single channel. */
  stopHeartbeat(channelId: string): void {
    const entry = this.entries.get(channelId);
    if (entry) {
      clearInterval(entry.timer);
      this.entries.delete(channelId);
      log.info(`Heartbeat stopped for channel=${channelId}`);
    }
  }

  /** Stop all running heartbeats (e.g. on shutdown). */
  stopAllHeartbeats(): void {
    for (const [channelId, entry] of this.entries) {
      clearInterval(entry.timer);
      log.debug(`Heartbeat cleared for channel=${channelId}`);
    }
    this.entries.clear();
    log.info("All heartbeats stopped");
  }

  /**
   * Record activity on a channel so the next heartbeat can decide
   * whether to skip.
   */
  recordActivity(channelId: string): void {
    const entry = this.entries.get(channelId);
    if (entry) {
      entry.lastActivity = Date.now();
    }
  }

  /** Return the number of active heartbeats (useful for tests / diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  /** Check whether a heartbeat is registered for the given channel. */
  hasHeartbeat(channelId: string): boolean {
    return this.entries.has(channelId);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private tick(channelId: string): void {
    const entry = this.entries.get(channelId);
    if (!entry) return;

    const now = Date.now();
    const activityThreshold = entry.interval / 2;

    if (now - entry.lastActivity < activityThreshold) {
      log.debug(`Heartbeat skipped for channel=${channelId} (recent activity)`);
      return;
    }

    log.debug(`Heartbeat firing for channel=${channelId} agent=${entry.agentId}`);

    // Fire-and-forget; errors are logged, not thrown into the timer.
    try {
      const result = entry.callback(channelId, entry.agentId);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err) =>
          log.error(`Heartbeat callback error channel=${channelId}: ${err}`),
        );
      }
    } catch (err) {
      log.error(`Heartbeat callback error channel=${channelId}: ${err}`);
    }
  }
}
