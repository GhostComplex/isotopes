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
 */
export class FailureTracker {
  // sessionId -> taskHash -> FailureRecord
  private failures = new Map<string, Map<string, FailureRecord>>();

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
    log.info("Cleared session failures", { sessionId });
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
