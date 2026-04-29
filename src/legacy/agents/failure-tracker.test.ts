import { describe, it, expect, beforeEach } from "vitest";
import { FailureTracker } from "./failure-tracker.js";

describe("FailureTracker", () => {
  let tracker: FailureTracker;

  beforeEach(() => {
    tracker = new FailureTracker();
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

  describe("recordFailure", () => {
    it("increments failure count independently per session", () => {
      tracker.recordFailure("session-1", "task A", "error");
      tracker.recordFailure("session-2", "task A", "error");
      expect(tracker.shouldBlock("session-1", "task A").blocked).toBe(false);
      expect(tracker.shouldBlock("session-2", "task A").blocked).toBe(false);
    });

    it("increments failure count independently per task", () => {
      tracker.recordFailure("session-1", "task A", "error");
      tracker.recordFailure("session-1", "task B", "error");
      expect(tracker.shouldBlock("session-1", "task A").blocked).toBe(false);
      expect(tracker.shouldBlock("session-1", "task B").blocked).toBe(false);
    });
  });

  describe("clearSession", () => {
    it("clears all failures and cancellations for a session", () => {
      tracker.recordFailure("session-1", "task A", "error");
      tracker.recordFailure("session-1", "task A", "error");
      tracker.recordCancel("session-1", "task C");
      tracker.clearSession("session-1");
      expect(tracker.shouldBlock("session-1", "task A").blocked).toBe(false);
      expect(tracker.shouldBlock("session-1", "task C").blocked).toBe(false);
    });

    it("does not affect other sessions", () => {
      tracker.recordFailure("session-1", "task A", "error");
      tracker.recordFailure("session-1", "task A", "error");
      tracker.recordFailure("session-2", "task A", "error");
      tracker.recordFailure("session-2", "task A", "error");
      tracker.clearSession("session-1");
      expect(tracker.shouldBlock("session-1", "task A").blocked).toBe(false);
      expect(tracker.shouldBlock("session-2", "task A").blocked).toBe(true);
    });
  });

  describe("task normalization", () => {
    it("treats similar tasks as the same (case insensitive)", () => {
      tracker.recordFailure("session-1", "Implement Feature X", "error");
      tracker.recordFailure("session-1", "implement feature x", "error");
      expect(tracker.shouldBlock("session-1", "implement feature x").blocked).toBe(true);
    });

    it("treats similar tasks as the same (extra whitespace)", () => {
      tracker.recordFailure("session-1", "implement   feature\n\nx", "error");
      tracker.recordFailure("session-1", "implement feature x", "error");
      expect(tracker.shouldBlock("session-1", "implement feature x").blocked).toBe(true);
    });

    it("only uses first 200 chars for hashing", () => {
      const longTask1 = "implement " + "a".repeat(300);
      const longTask2 = "implement " + "a".repeat(300) + " extra stuff";
      tracker.recordFailure("session-1", longTask1, "error");
      tracker.recordFailure("session-1", longTask2, "error");
      expect(tracker.shouldBlock("session-1", longTask2).blocked).toBe(true);
    });
  });

  describe("spawn rate limiting", () => {
    beforeEach(() => {
      tracker = new FailureTracker({ maxSpawnsPerWindow: 3, windowMs: 1000 });
    });

    it("allows spawns below rate limit", () => {
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      expect(tracker.shouldBlock("session-1", "any task").blocked).toBe(false);
    });

    it("blocks spawns at rate limit", () => {
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      const check = tracker.shouldBlock("session-1", "any task");
      expect(check.blocked).toBe(true);
      expect(check.reason).toContain("Rate limit");
    });

    it("tracks spawns independently per session", () => {
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-2");
      expect(tracker.shouldBlock("session-1", "task").blocked).toBe(true);
      expect(tracker.shouldBlock("session-2", "task").blocked).toBe(false);
    });

    it("cleans up old spawns outside the window", async () => {
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      expect(tracker.shouldBlock("session-1", "task").blocked).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(tracker.shouldBlock("session-1", "task").blocked).toBe(false);
    });

    it("shouldBlock checks rate limit before task-specific failures", () => {
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      const check = tracker.shouldBlock("session-1", "new task");
      expect(check.blocked).toBe(true);
      expect(check.reason).toContain("Rate limit");
    });

    it("clearSession clears spawn history", () => {
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      tracker.clearSession("session-1");
      expect(tracker.shouldBlock("session-1", "task").blocked).toBe(false);
    });

    it("catches prompt-variant spam that bypasses hash-based tracking", () => {
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      tracker.recordSpawn("session-1");
      const check1 = tracker.shouldBlock("session-1", "implement feature X");
      const check2 = tracker.shouldBlock("session-1", "implement feature Y");
      const check3 = tracker.shouldBlock("session-1", "implement feature Z");
      expect(check1.blocked).toBe(true);
      expect(check2.blocked).toBe(true);
      expect(check3.blocked).toBe(true);
      expect(check1.reason).toContain("Rate limit");
    });
  });
});
