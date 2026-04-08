// src/automation/cron-parser.test.ts — Unit tests for cron expression parser

import { describe, it, expect } from "vitest";
import { parseCronExpression, getNextRun, matchesCron } from "./cron-parser.js";

describe("cron-parser", () => {
  // -----------------------------------------------------------------------
  // parseCronExpression
  // -----------------------------------------------------------------------

  describe("parseCronExpression", () => {
    it("parses a simple wildcard expression", () => {
      const schedule = parseCronExpression("* * * * *");

      expect(schedule.minute).toHaveLength(60);    // 0-59
      expect(schedule.hour).toHaveLength(24);       // 0-23
      expect(schedule.dayOfMonth).toHaveLength(31); // 1-31
      expect(schedule.month).toHaveLength(12);      // 1-12
      expect(schedule.dayOfWeek).toHaveLength(7);   // 0-6
    });

    it("parses specific values", () => {
      const schedule = parseCronExpression("30 9 15 6 3");

      expect(schedule.minute).toEqual([30]);
      expect(schedule.hour).toEqual([9]);
      expect(schedule.dayOfMonth).toEqual([15]);
      expect(schedule.month).toEqual([6]);
      expect(schedule.dayOfWeek).toEqual([3]);
    });

    it("parses ranges", () => {
      const schedule = parseCronExpression("0-5 9-17 * * 1-5");

      expect(schedule.minute).toEqual([0, 1, 2, 3, 4, 5]);
      expect(schedule.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
      expect(schedule.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    });

    it("parses step values with wildcard", () => {
      const schedule = parseCronExpression("*/15 */6 * * *");

      expect(schedule.minute).toEqual([0, 15, 30, 45]);
      expect(schedule.hour).toEqual([0, 6, 12, 18]);
    });

    it("parses step values with ranges", () => {
      const schedule = parseCronExpression("0-30/10 * * * *");

      expect(schedule.minute).toEqual([0, 10, 20, 30]);
    });

    it("parses comma-separated lists", () => {
      const schedule = parseCronExpression("0,15,30,45 * * * *");

      expect(schedule.minute).toEqual([0, 15, 30, 45]);
    });

    it("parses mixed list with ranges", () => {
      const schedule = parseCronExpression("0,10-12,30 * * * *");

      expect(schedule.minute).toEqual([0, 10, 11, 12, 30]);
    });

    it("parses named days of week", () => {
      const schedule = parseCronExpression("0 9 * * mon-fri");

      expect(schedule.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    });

    it("parses named months", () => {
      const schedule = parseCronExpression("0 0 1 jan,jun,dec *");

      expect(schedule.month).toEqual([1, 6, 12]);
    });

    it("parses the 9 AM weekdays expression", () => {
      const schedule = parseCronExpression("0 9 * * 1-5");

      expect(schedule.minute).toEqual([0]);
      expect(schedule.hour).toEqual([9]);
      expect(schedule.dayOfMonth).toHaveLength(31);
      expect(schedule.month).toHaveLength(12);
      expect(schedule.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    });

    // Aliases
    it("parses @daily alias", () => {
      const schedule = parseCronExpression("@daily");

      expect(schedule.minute).toEqual([0]);
      expect(schedule.hour).toEqual([0]);
      expect(schedule.dayOfMonth).toHaveLength(31);
      expect(schedule.month).toHaveLength(12);
      expect(schedule.dayOfWeek).toHaveLength(7);
    });

    it("parses @hourly alias", () => {
      const schedule = parseCronExpression("@hourly");

      expect(schedule.minute).toEqual([0]);
      expect(schedule.hour).toHaveLength(24);
    });

    it("parses @weekly alias", () => {
      const schedule = parseCronExpression("@weekly");

      expect(schedule.minute).toEqual([0]);
      expect(schedule.hour).toEqual([0]);
      expect(schedule.dayOfWeek).toEqual([0]); // Sunday
    });

    it("parses @monthly alias", () => {
      const schedule = parseCronExpression("@monthly");

      expect(schedule.minute).toEqual([0]);
      expect(schedule.hour).toEqual([0]);
      expect(schedule.dayOfMonth).toEqual([1]);
    });

    it("parses @yearly alias", () => {
      const schedule = parseCronExpression("@yearly");

      expect(schedule.minute).toEqual([0]);
      expect(schedule.hour).toEqual([0]);
      expect(schedule.dayOfMonth).toEqual([1]);
      expect(schedule.month).toEqual([1]);
    });

    it("parses @annually alias (same as @yearly)", () => {
      const yearly = parseCronExpression("@yearly");
      const annually = parseCronExpression("@annually");

      expect(annually).toEqual(yearly);
    });

    it("parses @midnight alias (same as @daily)", () => {
      const daily = parseCronExpression("@daily");
      const midnight = parseCronExpression("@midnight");

      expect(midnight).toEqual(daily);
    });

    // Error handling
    it("throws on too few fields", () => {
      expect(() => parseCronExpression("* * *")).toThrow(
        'expected 5 fields, got 3',
      );
    });

    it("throws on too many fields", () => {
      expect(() => parseCronExpression("* * * * * *")).toThrow(
        'expected 5 fields, got 6',
      );
    });

    it("throws on unknown alias", () => {
      expect(() => parseCronExpression("@nope")).toThrow(
        'Unknown cron alias "@nope"',
      );
    });

    it("throws on out-of-range value", () => {
      expect(() => parseCronExpression("60 * * * *")).toThrow("out of range");
    });

    it("throws on invalid range (start > end)", () => {
      expect(() => parseCronExpression("30-10 * * * *")).toThrow("start > end");
    });

    it("throws on invalid step of 0", () => {
      expect(() => parseCronExpression("*/0 * * * *")).toThrow("Invalid step value 0");
    });

    it("throws on invalid value", () => {
      expect(() => parseCronExpression("abc * * * *")).toThrow("Invalid value");
    });

    it("handles extra whitespace gracefully", () => {
      const schedule = parseCronExpression("  0   9   *   *   1-5  ");

      expect(schedule.minute).toEqual([0]);
      expect(schedule.hour).toEqual([9]);
      expect(schedule.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    });
  });

  // -----------------------------------------------------------------------
  // matchesCron
  // -----------------------------------------------------------------------

  describe("matchesCron", () => {
    it("matches a date that satisfies all fields", () => {
      const schedule = parseCronExpression("30 9 * * 1-5");
      // Tuesday April 8, 2025 at 9:30 AM
      const date = new Date(2025, 3, 8, 9, 30, 0);

      expect(matchesCron(schedule, date)).toBe(true);
    });

    it("does not match when minute differs", () => {
      const schedule = parseCronExpression("30 9 * * *");
      const date = new Date(2025, 3, 8, 9, 31, 0);

      expect(matchesCron(schedule, date)).toBe(false);
    });

    it("does not match when hour differs", () => {
      const schedule = parseCronExpression("30 9 * * *");
      const date = new Date(2025, 3, 8, 10, 30, 0);

      expect(matchesCron(schedule, date)).toBe(false);
    });

    it("does not match when day of week differs", () => {
      const schedule = parseCronExpression("0 9 * * 1-5"); // weekdays only
      // Sunday
      const date = new Date(2025, 3, 6, 9, 0, 0);

      expect(matchesCron(schedule, date)).toBe(false);
    });

    it("does not match when month differs", () => {
      const schedule = parseCronExpression("0 0 1 6 *"); // June 1st
      const date = new Date(2025, 0, 1, 0, 0, 0); // January 1st

      expect(matchesCron(schedule, date)).toBe(false);
    });

    it("matches wildcard expression on any date", () => {
      const schedule = parseCronExpression("* * * * *");
      const date = new Date(2025, 7, 15, 14, 45, 0);

      expect(matchesCron(schedule, date)).toBe(true);
    });

    it("matches @daily at midnight", () => {
      const schedule = parseCronExpression("@daily");
      const midnight = new Date(2025, 3, 8, 0, 0, 0);
      const noon = new Date(2025, 3, 8, 12, 0, 0);

      expect(matchesCron(schedule, midnight)).toBe(true);
      expect(matchesCron(schedule, noon)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // getNextRun
  // -----------------------------------------------------------------------

  describe("getNextRun", () => {
    it("returns a date strictly after the 'from' date", () => {
      const schedule = parseCronExpression("* * * * *"); // every minute
      const from = new Date(2025, 3, 8, 9, 30, 15);

      const next = getNextRun(schedule, from);

      expect(next.getTime()).toBeGreaterThan(from.getTime());
    });

    it("returns the next matching minute", () => {
      const schedule = parseCronExpression("45 * * * *"); // at minute 45
      const from = new Date(2025, 3, 8, 9, 30, 0);

      const next = getNextRun(schedule, from);

      expect(next.getMinutes()).toBe(45);
      expect(next.getHours()).toBe(9); // same hour since 45 > 30
    });

    it("advances to the next hour when minute has passed", () => {
      const schedule = parseCronExpression("15 * * * *"); // at minute 15
      const from = new Date(2025, 3, 8, 9, 30, 0);

      const next = getNextRun(schedule, from);

      expect(next.getMinutes()).toBe(15);
      expect(next.getHours()).toBe(10); // next hour
    });

    it("computes next run for 9 AM weekdays", () => {
      const schedule = parseCronExpression("0 9 * * 1-5");
      // Friday at 10 AM — next matching is Monday 9 AM
      const friday = new Date(2025, 3, 4, 10, 0, 0); // April 4, 2025 is a Friday

      const next = getNextRun(schedule, friday);

      expect(next.getHours()).toBe(9);
      expect(next.getMinutes()).toBe(0);
      expect(next.getDay()).toBeGreaterThanOrEqual(1);
      expect(next.getDay()).toBeLessThanOrEqual(5);
    });

    it("computes next run for monthly schedule", () => {
      const schedule = parseCronExpression("0 0 1 * *"); // 1st of every month at midnight
      const from = new Date(2025, 3, 15, 12, 0, 0); // April 15th

      const next = getNextRun(schedule, from);

      expect(next.getDate()).toBe(1);
      expect(next.getMonth()).toBe(4); // May (0-indexed)
      expect(next.getHours()).toBe(0);
      expect(next.getMinutes()).toBe(0);
    });

    it("handles year rollover", () => {
      const schedule = parseCronExpression("0 0 1 1 *"); // Jan 1st at midnight
      const from = new Date(2025, 5, 15, 12, 0, 0); // June 15th

      const next = getNextRun(schedule, from);

      expect(next.getFullYear()).toBe(2026);
      expect(next.getMonth()).toBe(0); // January
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
  });
});
