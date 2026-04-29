import { createLogger } from "../vnext/logging/logger.js";

const log = createLogger("failure-tracker");

export interface BlockCheck {
  blocked: boolean;
  reason?: string;
}

export class FailureTracker {
  private failures = new Map<string, Map<string, number>>();
  private cancelled = new Map<string, Set<string>>();
  private spawnCounts = new Map<string, { count: number; windowStart: number }>();

  private maxSpawnsPerWindow: number;
  private windowMs: number;

  constructor(options?: { maxSpawnsPerWindow?: number; windowMs?: number }) {
    this.maxSpawnsPerWindow = options?.maxSpawnsPerWindow ?? 5;
    this.windowMs = options?.windowMs ?? 5 * 60 * 1000;
  }

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
    const entry = this.spawnCounts.get(sessionId);
    if (entry && Date.now() - entry.windowStart <= this.windowMs && entry.count >= this.maxSpawnsPerWindow) {
      return { blocked: true, reason: `Rate limit: ${entry.count} spawns in ${this.windowMs / 60000} min window.` };
    }

    const key = taskKey(task);

    if (this.cancelled.get(sessionId)?.has(key)) {
      return { blocked: true, reason: "This task was cancelled. Not re-attempting in this session." };
    }

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
}

function taskKey(task: string): string {
  return task.toLowerCase().trim().replace(/\s+/g, " ").slice(0, 200);
}

export const failureTracker = new FailureTracker();
