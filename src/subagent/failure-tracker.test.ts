// src/subagent/failure-tracker.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import { FailureTracker } from "./failure-tracker.js";

describe("FailureTracker", () => {
  let tracker: FailureTracker;

  beforeEach(() => {
    tracker = new FailureTracker();
  });

  describe("recordFailure", () => {
    it("increments failure count", () => {
      tracker.recordFailure("session-1", "implement feature X", "max turns");
      expect(tracker.getFailureCount("session-1", "implement feature X")).toBe(1);

      tracker.recordFailure("session-1", "implement feature X", "max turns");
      expect(tracker.getFailureCount("session-1", "implement feature X")).toBe(2);
    });

    it("tracks failures independently per session", () => {
      tracker.recordFailure("session-1", "task A", "error");
      tracker.recordFailure("session-2", "task A", "error");

      expect(tracker.getFailureCount("session-1", "task A")).toBe(1);
      expect(tracker.getFailureCount("session-2", "task A")).toBe(1);
    });

    it("tracks failures independently per task", () => {
      tracker.recordFailure("session-1", "task A", "error");
      tracker.recordFailure("session-1", "task B", "error");

      expect(tracker.getFailureCount("session-1", "task A")).toBe(1);
      expect(tracker.getFailureCount("session-1", "task B")).toBe(1);
    });
  });

  describe("recordCancel", () => {
    it("marks task as cancelled", () => {
      tracker.recordCancel("session-1", "implement feature X");
      expect(tracker.isCancelled("session-1", "implement feature X")).toBe(true);
    });

    it("does not increment failure count", () => {
      tracker.recordCancel("session-1", "task A");
      expect(tracker.getFailureCount("session-1", "task A")).toBe(0);
    });
  });

  describe("shouldBlock", () => {
    it("returns blocked:false for new task", () => {
      const result = tracker.shouldBlock("session-1", "new task");
      expect(result.blocked).toBe(false);
    });

    it("returns blocked:false after 1 failure (default maxFailures=2)", () => {
      tracker.recordFailure("session-1", "task A", "error");
      const result = tracker.shouldBlock("session-1", "task A");
      expect(result.blocked).toBe(false);
    });

    it("returns blocked:true after 2 failures (default maxFailures=2)", () => {
      tracker.recordFailure("session-1", "task A", "first error");
      tracker.recordFailure("session-1", "task A", "second error");
      const result = tracker.shouldBlock("session-1", "task A");
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("failed 2 times");
    });

    it("respects custom maxFailures", () => {
      tracker.recordFailure("session-1", "task A", "error");
      expect(tracker.shouldBlock("session-1", "task A", 1).blocked).toBe(true);
      expect(tracker.shouldBlock("session-1", "task A", 3).blocked).toBe(false);
    });

    it("returns blocked:true for cancelled task", () => {
      tracker.recordCancel("session-1", "task A");
      const result = tracker.shouldBlock("session-1", "task A");
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("cancelled");
    });

    it("blocks cancelled task even with 0 failures", () => {
      tracker.recordCancel("session-1", "task A");
      const result = tracker.shouldBlock("session-1", "task A", 10);
      expect(result.blocked).toBe(true);
    });
  });

  describe("clearSession", () => {
    it("clears all failures for a session", () => {
      tracker.recordFailure("session-1", "task A", "error");
      tracker.recordFailure("session-1", "task B", "error");
      tracker.recordCancel("session-1", "task C");

      tracker.clearSession("session-1");

      expect(tracker.getFailureCount("session-1", "task A")).toBe(0);
      expect(tracker.getFailureCount("session-1", "task B")).toBe(0);
      expect(tracker.isCancelled("session-1", "task C")).toBe(false);
    });

    it("does not affect other sessions", () => {
      tracker.recordFailure("session-1", "task A", "error");
      tracker.recordFailure("session-2", "task A", "error");

      tracker.clearSession("session-1");

      expect(tracker.getFailureCount("session-1", "task A")).toBe(0);
      expect(tracker.getFailureCount("session-2", "task A")).toBe(1);
    });
  });

  describe("task normalization", () => {
    it("treats similar tasks as the same (case insensitive)", () => {
      tracker.recordFailure("session-1", "Implement Feature X", "error");
      expect(tracker.getFailureCount("session-1", "implement feature x")).toBe(1);
    });

    it("treats similar tasks as the same (extra whitespace)", () => {
      tracker.recordFailure("session-1", "implement   feature\n\nx", "error");
      expect(tracker.getFailureCount("session-1", "implement feature x")).toBe(1);
    });

    it("only uses first 200 chars for hashing", () => {
      const longTask1 = "implement " + "a".repeat(300);
      const longTask2 = "implement " + "a".repeat(300) + " extra stuff";
      tracker.recordFailure("session-1", longTask1, "error");
      // Should match because first 200 chars are the same
      expect(tracker.getFailureCount("session-1", longTask2)).toBe(1);
    });
  });

  describe("spawn rate limiting", () => {
    beforeEach(() => {
      // Use a short window for testing
      tracker.setRateLimitConfig({ maxSpawnsPerWindow: 3, windowMs: 1000 });
    });

    it("allows spawns below rate limit", () => {
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");

      const check = tracker.isRateLimited("session-1");
      expect(check.blocked).toBe(false);
    });

    it("blocks spawns at rate limit", () => {
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");

      const check = tracker.isRateLimited("session-1");
      expect(check.blocked).toBe(true);
      expect(check.reason).toContain("Rate limit");
      expect(check.reason).toContain("3 spawns");
    });

    it("blocks spawns exceeding rate limit", () => {
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");

      const check = tracker.isRateLimited("session-1");
      expect(check.blocked).toBe(true);
      expect(check.reason).toContain("4 spawns");
    });

    it("tracks spawns independently per session", () => {
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");

      tracker.recordSpawn("session-2");

      expect(tracker.isRateLimited("session-1").blocked).toBe(true);
      expect(tracker.isRateLimited("session-2").blocked).toBe(false);
    });

    it("cleans up old spawns outside the window", async () => {
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");

      expect(tracker.isRateLimited("session-1").blocked).toBe(true);

      // Wait for window to expire
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Old spawns should be cleaned up
      expect(tracker.isRateLimited("session-1").blocked).toBe(false);
    });

    it("shouldBlock checks rate limit before task-specific failures", () => {
      // Trigger rate limit
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");

      // Task hasn't failed yet, but rate limit should block
      const check = tracker.shouldBlock("session-1", "new task");
      expect(check.blocked).toBe(true);
      expect(check.reason).toContain("Rate limit");
    });

    it("clearSession clears spawn history", () => {
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");

      tracker.clearSession("session-1");

      expect(tracker.isRateLimited("session-1").blocked).toBe(false);
    });

    it("setRateLimitConfig updates configuration", () => {
      tracker.setRateLimitConfig({ maxSpawnsPerWindow: 10, windowMs: 5000 });

      // Can now spawn more times
      for (let i = 0; i < 9; i++) {
        tracker.recordSpawn("session-1");
      }

      expect(tracker.isRateLimited("session-1").blocked).toBe(false);

      tracker.recordSpawn("session-1");
      expect(tracker.isRateLimited("session-1").blocked).toBe(true);
    });

    it("catches prompt-variant spam that bypasses hash-based tracking", () => {
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");

      // Different prompts (different hashes), but same session
      const check1 = tracker.shouldBlock("session-1", "implement feature X");
      const check2 = tracker.shouldBlock("session-1", "implement feature Y");
      const check3 = tracker.shouldBlock("session-1", "implement feature Z");

      // All should be blocked by rate limit despite different prompts
      expect(check1.blocked).toBe(true);
      expect(check2.blocked).toBe(true);
      expect(check3.blocked).toBe(true);
      expect(check1.reason).toContain("Rate limit");
    });
  });
});
