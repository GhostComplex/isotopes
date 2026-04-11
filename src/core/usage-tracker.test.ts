import { describe, it, expect, beforeEach } from "vitest";
import { UsageTracker } from "./usage-tracker.js";
import type { Usage } from "./types.js";

function makeUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 100,
    output: 50,
    cacheRead: 10,
    cacheWrite: 5,
    totalTokens: 165,
    cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.0005, total: 0.03 },
    ...overrides,
  };
}

describe("UsageTracker", () => {
  let tracker: UsageTracker;

  beforeEach(() => {
    tracker = new UsageTracker();
  });

  describe("record()", () => {
    it("creates session usage on first record", () => {
      tracker.record("s1", makeUsage());
      const session = tracker.getSession("s1");
      expect(session).toBeDefined();
      expect(session!.input).toBe(100);
      expect(session!.output).toBe(50);
      expect(session!.totalTokens).toBe(165);
      expect(session!.cost).toBe(0.03);
      expect(session!.turns).toBe(1);
    });

    it("accumulates across multiple records in same session", () => {
      tracker.record("s1", makeUsage());
      tracker.record("s1", makeUsage({ input: 200, output: 100, totalTokens: 310 }));
      const session = tracker.getSession("s1")!;
      expect(session.input).toBe(300);
      expect(session.output).toBe(150);
      expect(session.totalTokens).toBe(475);
      expect(session.turns).toBe(2);
    });

    it("increments global totals", () => {
      tracker.record("s1", makeUsage());
      tracker.record("s2", makeUsage());
      const global = tracker.getGlobal();
      expect(global.input).toBe(200);
      expect(global.turns).toBe(2);
    });

    it("tracks cache fields", () => {
      tracker.record("s1", makeUsage({ cacheRead: 20, cacheWrite: 8 }));
      const session = tracker.getSession("s1")!;
      expect(session.cacheRead).toBe(20);
      expect(session.cacheWrite).toBe(8);
    });
  });

  describe("getSession()", () => {
    it("returns undefined for unknown session", () => {
      expect(tracker.getSession("nonexistent")).toBeUndefined();
    });

    it("returns session usage after recording", () => {
      tracker.record("s1", makeUsage());
      expect(tracker.getSession("s1")).toBeDefined();
    });
  });

  describe("getGlobal()", () => {
    it("returns zeros before any records", () => {
      const global = tracker.getGlobal();
      expect(global.totalTokens).toBe(0);
      expect(global.cost).toBe(0);
      expect(global.turns).toBe(0);
    });

    it("sums across all sessions", () => {
      tracker.record("s1", makeUsage({ totalTokens: 100 }));
      tracker.record("s2", makeUsage({ totalTokens: 200 }));
      tracker.record("s1", makeUsage({ totalTokens: 50 }));
      const global = tracker.getGlobal();
      expect(global.totalTokens).toBe(350);
      expect(global.turns).toBe(3);
    });
  });

  describe("deleteSession()", () => {
    it("removes session from tracker", () => {
      tracker.record("s1", makeUsage());
      tracker.deleteSession("s1");
      expect(tracker.getSession("s1")).toBeUndefined();
    });

    it("does not affect global totals", () => {
      tracker.record("s1", makeUsage());
      const costBefore = tracker.getGlobal().cost;
      tracker.deleteSession("s1");
      expect(tracker.getGlobal().cost).toBe(costBefore);
    });

    it("no-ops for unknown session", () => {
      expect(() => tracker.deleteSession("nonexistent")).not.toThrow();
    });
  });
});
