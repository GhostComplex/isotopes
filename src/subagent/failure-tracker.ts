// src/subagent/failure-tracker.ts — Tracks subagent task failures per session
// Prevents repeated spawning of failing tasks.

import { createLogger } from "../core/logger.js";

const log = createLogger("failure-tracker");

/** Record of failures for a specific task. */
interface FailureRecord {
  count: number;
  lastError: string;
  cancelled: boolean;
}

/** Result of checking if a task should be blocked. */
export interface BlockCheck {
  blocked: boolean;
  reason?: string;
}

/** Configuration for failure tracker rate limiting. */
export interface RateLimitConfig {
  /** Maximum number of spawns allowed within the time window. */
  maxSpawnsPerWindow: number;
  /** Time window in milliseconds. */
  windowMs: number;
}

/**
 * Hash a task description into a short key.
 * Uses first 200 chars, normalized (lowercase, single spaces).
 */
function hashTask(task: string): string {
  const normalized = task.toLowerCase().trim().replace(/\s+/g, " ").slice(0, 200);
  // djb2 hash
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash) + normalized.charCodeAt(i);
  }
  // Return positive number in base36
  return (hash >>> 0).toString(36);
}

/**
 * FailureTracker — per-session memory of task failures.
 *
 * Tracks how many times a task has failed in a session. After N failures,
 * blocks further attempts. Also tracks explicitly cancelled tasks (/stop).
 *
 * Additionally enforces spawn rate limiting per session to prevent rapid
 * spawning loops when prompts vary slightly (bypassing hash-based tracking).
 */
export class FailureTracker {
  // sessionId -> taskHash -> FailureRecord
  private failures = new Map<string, Map<string, FailureRecord>>();
  // sessionId -> array of spawn timestamps
  private sessionSpawns = new Map<string, number[]>();
  // Rate limit configuration
  private rateLimitConfig: RateLimitConfig = {
    maxSpawnsPerWindow: 5,
    windowMs: 5 * 60 * 1000, // 5 minutes
  };

  /**
   * Record a task failure.
   */
  recordFailure(sessionId: string, task: string, error: string): void {
    const taskHash = hashTask(task);
    let sessionMap = this.failures.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map();
      this.failures.set(sessionId, sessionMap);
    }

    const record = sessionMap.get(taskHash);
    if (record) {
      record.count++;
      record.lastError = error;
    } else {
      sessionMap.set(taskHash, { count: 1, lastError: error, cancelled: false });
    }

    log.info("Recorded task failure", { sessionId, taskHash, count: sessionMap.get(taskHash)?.count });
  }

  /**
   * Record a task cancellation (e.g., /stop command).
   * Cancelled tasks are immediately blocked from re-attempt.
   */
  recordCancel(sessionId: string, task: string): void {
    const taskHash = hashTask(task);
    let sessionMap = this.failures.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map();
      this.failures.set(sessionId, sessionMap);
    }

    const record = sessionMap.get(taskHash);
    if (record) {
      record.cancelled = true;
    } else {
      sessionMap.set(taskHash, { count: 0, lastError: "cancelled", cancelled: true });
    }

    log.info("Recorded task cancellation", { sessionId, taskHash });
  }

  /**
   * Check if a task should be blocked.
   * @param maxFailures - Number of failures before blocking (default: 2)
   */
  shouldBlock(sessionId: string, task: string, maxFailures = 2): BlockCheck {
    // First check spawn rate limit (hash-independent)
    const rateLimitCheck = this.isRateLimited(sessionId);
    if (rateLimitCheck.blocked) {
      return rateLimitCheck;
    }

    // Then check task-specific failures (hash-based)
    const taskHash = hashTask(task);
    const sessionMap = this.failures.get(sessionId);
    if (!sessionMap) {
      return { blocked: false };
    }

    const record = sessionMap.get(taskHash);
    if (!record) {
      return { blocked: false };
    }

    if (record.cancelled) {
      return {
        blocked: true,
        reason: "This task was cancelled. Not re-attempting in this session.",
      };
    }

    if (record.count >= maxFailures) {
      return {
        blocked: true,
        reason: `This task has failed ${record.count} times. Last error: ${record.lastError}. Not re-attempting.`,
      };
    }

    return { blocked: false };
  }

  /**
   * Clear all failure records for a session.
   * Called when session is reset (/new, /reset).
   */
  clearSession(sessionId: string): void {
    this.failures.delete(sessionId);
    this.sessionSpawns.delete(sessionId);
    log.info("Cleared session failures", { sessionId });
  }

  /**
   * Record a spawn attempt for rate limiting.
   * Should be called before spawning a subagent.
   */
  recordSpawn(sessionId: string): void {
    const now = Date.now();
    let spawns = this.sessionSpawns.get(sessionId);
    if (!spawns) {
      spawns = [];
      this.sessionSpawns.set(sessionId, spawns);
    }
    spawns.push(now);

    // Clean up old timestamps outside the window
    const cutoff = now - this.rateLimitConfig.windowMs;
    const filtered = spawns.filter(ts => ts > cutoff);
    this.sessionSpawns.set(sessionId, filtered);

    log.info("Recorded spawn attempt", {
      sessionId,
      count: filtered.length,
      window: `${this.rateLimitConfig.windowMs / 1000}s`,
    });
  }

  /**
   * Check if a session is rate limited (spawn frequency too high).
   * This is a hash-independent safety net to prevent spawn loops.
   */
  isRateLimited(sessionId: string): BlockCheck {
    const now = Date.now();
    const spawns = this.sessionSpawns.get(sessionId) || [];

    // Clean up old timestamps
    const cutoff = now - this.rateLimitConfig.windowMs;
    const recentSpawns = spawns.filter(ts => ts > cutoff);

    if (recentSpawns.length >= this.rateLimitConfig.maxSpawnsPerWindow) {
      const windowMinutes = Math.floor(this.rateLimitConfig.windowMs / 60000);
      return {
        blocked: true,
        reason: `Rate limit exceeded: ${recentSpawns.length} spawn attempts in the last ${windowMinutes} minute(s). Maximum allowed: ${this.rateLimitConfig.maxSpawnsPerWindow}. This prevents infinite spawn loops.`,
      };
    }

    return { blocked: false };
  }

  /**
   * Configure rate limiting behavior.
   * @param config - Rate limit configuration
   */
  setRateLimitConfig(config: Partial<RateLimitConfig>): void {
    this.rateLimitConfig = { ...this.rateLimitConfig, ...config };
    log.info("Updated rate limit config", this.rateLimitConfig);
  }

  /**
   * Get the failure count for a specific task (for testing).
   */
  getFailureCount(sessionId: string, task: string): number {
    const taskHash = hashTask(task);
    const sessionMap = this.failures.get(sessionId);
    return sessionMap?.get(taskHash)?.count ?? 0;
  }

  /**
   * Check if a task is cancelled (for testing).
   */
  isCancelled(sessionId: string, task: string): boolean {
    const taskHash = hashTask(task);
    const sessionMap = this.failures.get(sessionId);
    return sessionMap?.get(taskHash)?.cancelled ?? false;
  }
}

/** Singleton failure tracker shared across the application. */
export const failureTracker = new FailureTracker();
