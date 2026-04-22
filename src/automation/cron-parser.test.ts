import { describe, it, expect } from "vitest";
import { parseCronExpression, getNextRun, matchesCron } from "./cron-parser.js";

describe("cron-parser", () => {
  describe("parseCronExpression", () => {
    it("parses a wildcard expression (matches any date)", () => {
      const schedule = parseCronExpression("* * * * *");
      expect(matchesCron(schedule, new Date(2025, 7, 15, 14, 45, 0))).toBe(true);
    });

    it("parses specific values", () => {
      const schedule = parseCronExpression("30 9 15 6 3");
      // June 15, 2025 is a Sunday (day 0), not Wednesday (day 3)
      // but POSIX OR: matches because day-of-month (15) matches
      expect(matchesCron(schedule, new Date(2025, 5, 18, 9, 30, 0))).toBe(true); // June 18 2025 is Wed
      expect(matchesCron(schedule, new Date(2025, 5, 18, 9, 31, 0))).toBe(false);
    });

    it("parses ranges", () => {
      const schedule = parseCronExpression("0-5 9-17 * * 1-5");
      expect(matchesCron(schedule, new Date(2025, 3, 8, 9, 3, 0))).toBe(true);  // Tue 9:03
      expect(matchesCron(schedule, new Date(2025, 3, 8, 9, 6, 0))).toBe(false); // Tue 9:06 (minute 6 out of range)
      expect(matchesCron(schedule, new Date(2025, 3, 6, 9, 3, 0))).toBe(false); // Sun 9:03 (weekend)
    });

    it("parses step values", () => {
      const schedule = parseCronExpression("*/15 */6 * * *");
      expect(matchesCron(schedule, new Date(2025, 3, 8, 0, 0, 0))).toBe(true);
      expect(matchesCron(schedule, new Date(2025, 3, 8, 6, 15, 0))).toBe(true);
      expect(matchesCron(schedule, new Date(2025, 3, 8, 3, 0, 0))).toBe(false);
      expect(matchesCron(schedule, new Date(2025, 3, 8, 0, 7, 0))).toBe(false);
    });

    it("parses step values with ranges", () => {
      const schedule = parseCronExpression("0-30/10 * * * *");
      expect(matchesCron(schedule, new Date(2025, 3, 8, 0, 0, 0))).toBe(true);
      expect(matchesCron(schedule, new Date(2025, 3, 8, 0, 10, 0))).toBe(true);
      expect(matchesCron(schedule, new Date(2025, 3, 8, 0, 20, 0))).toBe(true);
      expect(matchesCron(schedule, new Date(2025, 3, 8, 0, 30, 0))).toBe(true);
      expect(matchesCron(schedule, new Date(2025, 3, 8, 0, 40, 0))).toBe(false);
    });

    it("parses comma-separated lists", () => {
      const schedule = parseCronExpression("0,15,30,45 * * * *");
      expect(matchesCron(schedule, new Date(2025, 3, 8, 0, 0, 0))).toBe(true);
      expect(matchesCron(schedule, new Date(2025, 3, 8, 0, 15, 0))).toBe(true);
      expect(matchesCron(schedule, new Date(2025, 3, 8, 0, 7, 0))).toBe(false);
    });

    it("parses named days of week", () => {
      const schedule = parseCronExpression("0 9 * * mon-fri");
      expect(matchesCron(schedule, new Date(2025, 3, 8, 9, 0, 0))).toBe(true);  // Tue
      expect(matchesCron(schedule, new Date(2025, 3, 6, 9, 0, 0))).toBe(false); // Sun
    });

    it("parses named months", () => {
      const schedule = parseCronExpression("0 0 1 jan,jun,dec *");
      expect(matchesCron(schedule, new Date(2025, 0, 1, 0, 0, 0))).toBe(true);  // Jan 1
      expect(matchesCron(schedule, new Date(2025, 5, 1, 0, 0, 0))).toBe(true);  // Jun 1
      expect(matchesCron(schedule, new Date(2025, 2, 1, 0, 0, 0))).toBe(false); // Mar 1
    });

    // Aliases
    it("parses @daily alias", () => {
      const schedule = parseCronExpression("@daily");
      expect(matchesCron(schedule, new Date(2025, 3, 8, 0, 0, 0))).toBe(true);
      expect(matchesCron(schedule, new Date(2025, 3, 8, 12, 0, 0))).toBe(false);
    });

    it("parses @hourly alias", () => {
      const schedule = parseCronExpression("@hourly");
      expect(matchesCron(schedule, new Date(2025, 3, 8, 5, 0, 0))).toBe(true);
      expect(matchesCron(schedule, new Date(2025, 3, 8, 5, 30, 0))).toBe(false);
    });

    it("parses @weekly alias (Sunday midnight)", () => {
      const schedule = parseCronExpression("@weekly");
      expect(matchesCron(schedule, new Date(2025, 3, 6, 0, 0, 0))).toBe(true);  // Sun
      expect(matchesCron(schedule, new Date(2025, 3, 7, 0, 0, 0))).toBe(false); // Mon
    });

    it("parses @monthly alias", () => {
      const schedule = parseCronExpression("@monthly");
      expect(matchesCron(schedule, new Date(2025, 3, 1, 0, 0, 0))).toBe(true);
      expect(matchesCron(schedule, new Date(2025, 3, 2, 0, 0, 0))).toBe(false);
    });

    it("parses @yearly alias", () => {
      const schedule = parseCronExpression("@yearly");
      expect(matchesCron(schedule, new Date(2025, 0, 1, 0, 0, 0))).toBe(true);  // Jan 1
      expect(matchesCron(schedule, new Date(2025, 1, 1, 0, 0, 0))).toBe(false); // Feb 1
    });

    // Error handling
    it("throws on too few fields", () => {
      expect(() => parseCronExpression("* * *")).toThrow("expected 5 fields, got 3");
    });

    it("throws on too many fields", () => {
      expect(() => parseCronExpression("* * * * * *")).toThrow("expected 5 fields, got 6");
    });

    it("throws on unknown alias", () => {
      expect(() => parseCronExpression("@nope")).toThrow('Unknown cron alias "@nope"');
    });

    it("handles extra whitespace gracefully", () => {
      const schedule = parseCronExpression("  0   9   *   *   1-5  ");
      expect(matchesCron(schedule, new Date(2025, 3, 8, 9, 0, 0))).toBe(true); // Tue
    });
  });

  describe("matchesCron", () => {
    it("matches a date that satisfies all fields", () => {
      const schedule = parseCronExpression("30 9 * * 1-5");
      const date = new Date(2025, 3, 8, 9, 30, 0);
      expect(matchesCron(schedule, date)).toBe(true);
    });

    it("does not match when minute differs", () => {
      const schedule = parseCronExpression("30 9 * * *");
      expect(matchesCron(schedule, new Date(2025, 3, 8, 9, 31, 0))).toBe(false);
    });

    it("does not match when hour differs", () => {
      const schedule = parseCronExpression("30 9 * * *");
      expect(matchesCron(schedule, new Date(2025, 3, 8, 10, 30, 0))).toBe(false);
    });

    it("does not match when day of week differs", () => {
      const schedule = parseCronExpression("0 9 * * 1-5");
      expect(matchesCron(schedule, new Date(2025, 3, 6, 9, 0, 0))).toBe(false); // Sun
    });

    it("does not match when month differs", () => {
      const schedule = parseCronExpression("0 0 1 6 *");
      expect(matchesCron(schedule, new Date(2025, 0, 1, 0, 0, 0))).toBe(false); // Jan != Jun
    });

    it("matches wildcard expression on any date", () => {
      const schedule = parseCronExpression("* * * * *");
      expect(matchesCron(schedule, new Date(2025, 7, 15, 14, 45, 0))).toBe(true);
    });

    it("matches @daily at midnight", () => {
      const schedule = parseCronExpression("@daily");
      expect(matchesCron(schedule, new Date(2025, 3, 8, 0, 0, 0))).toBe(true);
      expect(matchesCron(schedule, new Date(2025, 3, 8, 12, 0, 0))).toBe(false);
    });
  });

  describe("getNextRun", () => {
    it("returns a date strictly after the 'from' date", () => {
      const schedule = parseCronExpression("* * * * *");
      const from = new Date(2025, 3, 8, 9, 30, 15);
      const next = getNextRun(schedule, from);
      expect(next.getTime()).toBeGreaterThan(from.getTime());
    });

    it("returns the next matching minute", () => {
      const schedule = parseCronExpression("45 * * * *");
      const from = new Date(2025, 3, 8, 9, 30, 0);
      const next = getNextRun(schedule, from);
      expect(next.getMinutes()).toBe(45);
      expect(next.getHours()).toBe(9);
    });

    it("advances to the next hour when minute has passed", () => {
      const schedule = parseCronExpression("15 * * * *");
      const from = new Date(2025, 3, 8, 9, 30, 0);
      const next = getNextRun(schedule, from);
      expect(next.getMinutes()).toBe(15);
      expect(next.getHours()).toBe(10);
    });

    it("computes next run for 9 AM weekdays", () => {
      const schedule = parseCronExpression("0 9 * * 1-5");
      const friday = new Date(2025, 3, 4, 10, 0, 0);
      const next = getNextRun(schedule, friday);
      expect(next.getHours()).toBe(9);
      expect(next.getMinutes()).toBe(0);
      expect(next.getDay()).toBeGreaterThanOrEqual(1);
      expect(next.getDay()).toBeLessThanOrEqual(5);
    });

    it("computes next run for monthly schedule", () => {
      const schedule = parseCronExpression("0 0 1 * *");
      const from = new Date(2025, 3, 15, 12, 0, 0);
      const next = getNextRun(schedule, from);
      expect(next.getDate()).toBe(1);
      expect(next.getMonth()).toBe(4);
      expect(next.getHours()).toBe(0);
      expect(next.getMinutes()).toBe(0);
    });

    it("handles year rollover", () => {
      const schedule = parseCronExpression("0 0 1 1 *");
      const from = new Date(2025, 5, 15, 12, 0, 0);
      const next = getNextRun(schedule, from);
      expect(next.getFullYear()).toBe(2026);
      expect(next.getMonth()).toBe(0);
      expect(next.getDate()).toBe(1);
    });

    it("defaults 'from' to now when not provided", () => {
      const schedule = parseCronExpression("* * * * *");
      const next = getNextRun(schedule);
      expect(next.getTime()).toBeGreaterThan(Date.now() - 1000);
    });

    it("zero-seconds on result", () => {
      const schedule = parseCronExpression("* * * * *");
      const from = new Date(2025, 3, 8, 9, 30, 45);
      const next = getNextRun(schedule, from);
      expect(next.getSeconds()).toBe(0);
      expect(next.getMilliseconds()).toBe(0);
    });

    // POSIX OR logic
    it("uses OR logic when both day-of-month and day-of-week are specified", () => {
      const schedule = parseCronExpression("0 9 15 * 1");
      // April 14, 2025 is Monday — matches via day-of-week
      expect(matchesCron(schedule, new Date(2025, 3, 14, 9, 0, 0))).toBe(true);
      // April 15, 2025 is Tuesday — matches via day-of-month
      expect(matchesCron(schedule, new Date(2025, 3, 15, 9, 0, 0))).toBe(true);
      // April 16, 2025 is Wednesday — neither
      expect(matchesCron(schedule, new Date(2025, 3, 16, 9, 0, 0))).toBe(false);
    });

    it("uses AND logic when only day-of-month is specified (day-of-week is *)", () => {
      const schedule = parseCronExpression("0 9 15 * *");
      expect(matchesCron(schedule, new Date(2025, 3, 15, 9, 0, 0))).toBe(true);
      expect(matchesCron(schedule, new Date(2025, 3, 14, 9, 0, 0))).toBe(false);
    });

    it("uses AND logic when only day-of-week is specified (day-of-month is *)", () => {
      const schedule = parseCronExpression("0 9 * * 1");
      expect(matchesCron(schedule, new Date(2025, 3, 14, 9, 0, 0))).toBe(true);  // Mon
      expect(matchesCron(schedule, new Date(2025, 3, 15, 9, 0, 0))).toBe(false); // Tue
    });

    it("getNextRun respects OR logic for non-wildcard day fields", () => {
      const schedule = parseCronExpression("0 9 15 * 1");
      const from = new Date(2025, 3, 12, 10, 0, 0); // Saturday
      const next = getNextRun(schedule, from);
      // Next match: April 14 (Monday), not April 15 (Tuesday)
      expect(next.getDate()).toBe(14);
      expect(next.getDay()).toBe(1);
    });
  });
});
