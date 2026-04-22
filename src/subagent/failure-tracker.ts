// src/subagent/failure-tracker.ts — Prevents repeated spawning of failing tasks

import { createLogger } from "../core/logger.js";

const log = createLogger("failure-tracker");

export interface BlockCheck {
  blocked: boolean;
  reason?: string;
}

export class FailureTracker {
  // sessionId → taskKey → failure count
  private failures = new Map<string, Map<string, number>>();
  // sessionId → set of cancelled task keys
  private cancelled = new Map<string, Set<string>>();
  // sessionId → spawn count in current window
  private spawnCounts = new Map<string, { count: number; windowStart: number }>();

  private maxSpawnsPerWindow = 5;
  private windowMs = 5 * 60 * 1000;

  recordFailure(sessionId: string, task: string, _error: string): void {
    const key = taskKey(task);
    let map = this.failures.get(sessionId);
    if (!map) {
      map = new Map();
      this.failures.set(sessionId, map);
    }
    const count = (map.get(key) ?? 0) + 1;
    map.set(key, count);
    log.info("Recorded task failure", { sessionId, count });
  }

  recordCancel(sessionId: string, task: string): void {
    const key = taskKey(task);
    let set = this.cancelled.get(sessionId);
    if (!set) {
      set = new Set();
      this.cancelled.set(sessionId, set);
    }
    set.add(key);
  }

  recordSpawn(sessionId: string): void {
    const now = Date.now();
    const entry = this.spawnCounts.get(sessionId);
    if (!entry || now - entry.windowStart > this.windowMs) {
      this.spawnCounts.set(sessionId, { count: 1, windowStart: now });
    } else {
      entry.count++;
    }
  }

  shouldBlock(sessionId: string, task: string, maxFailures = 2): BlockCheck {
    // Rate limit check
    const entry = this.spawnCounts.get(sessionId);
    if (entry && Date.now() - entry.windowStart <= this.windowMs && entry.count >= this.maxSpawnsPerWindow) {
      return { blocked: true, reason: `Rate limit: ${entry.count} spawns in ${this.windowMs / 60000} min window.` };
    }

    const key = taskKey(task);

    // Cancelled check
    if (this.cancelled.get(sessionId)?.has(key)) {
      return { blocked: true, reason: "This task was cancelled. Not re-attempting in this session." };
    }

    // Failure count check
    const count = this.failures.get(sessionId)?.get(key) ?? 0;
    if (count >= maxFailures) {
      return { blocked: true, reason: `This task has failed ${count} times. Not re-attempting.` };
    }

    return { blocked: false };
  }

  clearSession(sessionId: string): void {
    this.failures.delete(sessionId);
    this.cancelled.delete(sessionId);
    this.spawnCounts.delete(sessionId);
  }

  getFailureCount(sessionId: string, task: string): number {
    return this.failures.get(sessionId)?.get(taskKey(task)) ?? 0;
  }

  isCancelled(sessionId: string, task: string): boolean {
    return this.cancelled.get(sessionId)?.has(taskKey(task)) ?? false;
  }

  setRateLimitConfig(config: { maxSpawnsPerWindow?: number; windowMs?: number }): void {
    if (config.maxSpawnsPerWindow !== undefined) this.maxSpawnsPerWindow = config.maxSpawnsPerWindow;
    if (config.windowMs !== undefined) this.windowMs = config.windowMs;
    log.info("Updated rate limit config", { maxSpawnsPerWindow: this.maxSpawnsPerWindow, windowMs: this.windowMs });
  }

  isRateLimited(sessionId: string): BlockCheck {
    const entry = this.spawnCounts.get(sessionId);
    if (entry && Date.now() - entry.windowStart <= this.windowMs && entry.count >= this.maxSpawnsPerWindow) {
      return { blocked: true, reason: `Rate limit: ${entry.count} spawns in ${this.windowMs / 60000} min window.` };
    }
    return { blocked: false };
  }
}

function taskKey(task: string): string {
  return task.toLowerCase().trim().replace(/\s+/g, " ").slice(0, 200);
}

export const failureTracker = new FailureTracker();
