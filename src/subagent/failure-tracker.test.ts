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
      expect(result.reason).toContain("second error");
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
});
