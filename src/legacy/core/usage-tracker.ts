// src/core/usage-tracker.ts — In-memory usage accumulation (per-session + global)
// Resets on process restart. No persistence.

import type { Usage } from "./types.js";

/** Accumulated usage stats for a session or globally. */
export interface AccumulatedUsage {
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

function emptyUsage(): AccumulatedUsage {
  return { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

/**
 * Tracks token usage per-session and globally (total since startup).
 * Thread-safe for single-process Node — no locking needed.
 */
export class UsageTracker {
  private sessions = new Map<string, AccumulatedUsage>();
  private global: AccumulatedUsage = emptyUsage();

  /** Record a single turn's usage for a session. */
  record(sessionId: string, usage: Usage): void {
    // Per-session
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = emptyUsage();
      this.sessions.set(sessionId, s);
    }
    accumulate(s, usage);

    // Global
    accumulate(this.global, usage);
  }

  /** Get accumulated usage for a session, or undefined if no usage recorded. */
  getSession(sessionId: string): AccumulatedUsage | undefined {
    return this.sessions.get(sessionId);
  }

  /** Get global accumulated usage since startup. */
  getGlobal(): AccumulatedUsage {
    return this.global;
  }

  /** Remove tracking data for a session (e.g. on session delete). */
  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

function accumulate(acc: AccumulatedUsage, usage: Usage): void {
  acc.totalTokens += usage.totalTokens;
  acc.input += usage.input;
  acc.output += usage.output;
  acc.cacheRead += usage.cacheRead;
  acc.cacheWrite += usage.cacheWrite;
  acc.cost += usage.cost.total;
  acc.turns += 1;
}
