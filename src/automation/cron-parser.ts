// src/automation/cron-parser.ts — Cron expression parser for Isotopes
// Parses standard 5-field cron expressions and computes next-run times.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed cron schedule with expanded numeric arrays for each field. */
export interface CronSchedule {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

// ---------------------------------------------------------------------------
// Field bounds
// ---------------------------------------------------------------------------

interface FieldSpec {
  min: number;
  max: number;
}

const FIELD_SPECS: FieldSpec[] = [
  { min: 0, max: 59 },  // minute
  { min: 0, max: 23 },  // hour
  { min: 1, max: 31 },  // day of month
  { min: 1, max: 12 },  // month
  { min: 0, max: 6 },   // day of week (0=Sun)
];

// ---------------------------------------------------------------------------
// Special aliases
// ---------------------------------------------------------------------------

const ALIASES: Record<string, string> = {
  "@yearly":  "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly":  "0 0 * * 0",
  "@daily":   "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly":  "0 * * * *",
};

// Day-of-week name map
const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

// Month name map
const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a single cron field (e.g., "1,5,10", "0-59/15", "1-5", "*").
 * Returns a sorted array of numeric values.
 */
function parseField(field: string, spec: FieldSpec, fieldIndex: number): number[] {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const trimmed = part.trim();

    // Step with range: */n or n-m/s
    const stepMatch = trimmed.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const [, rangePart, stepStr] = stepMatch;
      const step = Number(stepStr);
      if (step === 0) throw new Error(`Invalid step value 0 in field ${fieldIndex}`);

      let start: number;
      let end: number;

      if (rangePart === "*") {
        start = spec.min;
        end = spec.max;
      } else {
        const range = parseRange(rangePart, spec, fieldIndex);
        start = range[0];
        end = range[range.length - 1];
      }

      for (let i = start; i <= end; i += step) {
        values.add(i);
      }
      continue;
    }

    if (trimmed === "*") {
      for (let i = spec.min; i <= spec.max; i++) {
        values.add(i);
      }
      continue;
    }

    if (trimmed.includes("-")) {
      for (const v of parseRange(trimmed, spec, fieldIndex)) {
        values.add(v);
      }
      continue;
    }

    // Single value
    const num = resolveValue(trimmed, fieldIndex);
    if (num < spec.min || num > spec.max) {
      throw new Error(
        `Value ${num} out of range [${spec.min}-${spec.max}] in field ${fieldIndex}`,
      );
    }
    values.add(num);
  }

  return [...values].sort((a, b) => a - b);
}

/**
 * Parse a range expression like "1-5" and return all values in [start, end].
 */
function parseRange(expr: string, spec: FieldSpec, fieldIndex: number): number[] {
  const [startStr, endStr] = expr.split("-");
  const start = resolveValue(startStr, fieldIndex);
  const end = resolveValue(endStr, fieldIndex);

  if (start < spec.min || end > spec.max) {
    throw new Error(
      `Range ${start}-${end} out of bounds [${spec.min}-${spec.max}] in field ${fieldIndex}`,
    );
  }
  if (start > end) {
    throw new Error(
      `Invalid range ${start}-${end} in field ${fieldIndex} (start > end)`,
    );
  }

  const result: number[] = [];
  for (let i = start; i <= end; i++) {
    result.push(i);
  }
  return result;
}

/**
 * Resolve a value string to a number, supporting named days/months.
 */
function resolveValue(str: string, fieldIndex: number): number {
  const lower = str.trim().toLowerCase();

  // Day-of-week names (field index 4)
  if (fieldIndex === 4 && DOW_NAMES[lower] !== undefined) {
    return DOW_NAMES[lower];
  }

  // Month names (field index 3)
  if (fieldIndex === 3 && MONTH_NAMES[lower] !== undefined) {
    return MONTH_NAMES[lower];
  }

  const num = Number(lower);
  if (Number.isNaN(num)) {
    throw new Error(`Invalid value "${str}" in field ${fieldIndex}`);
  }
  return num;
}

/**
 * Parse a standard 5-field cron expression.
 *
 * Format: `minute hour day-of-month month day-of-week`
 *
 * Supports:
 * - Wildcards: `*`
 * - Ranges: `1-5`
 * - Steps: `* /15` (no space), `1-5/2`
 * - Lists: `1,3,5`
 * - Named days: `mon-fri`, `sun`
 * - Named months: `jan`, `feb`, etc.
 * - Aliases: `@daily`, `@hourly`, `@weekly`, `@monthly`, `@yearly`
 */
export function parseCronExpression(expr: string): CronSchedule {
  const trimmed = expr.trim().toLowerCase();

  // Check for aliases
  if (trimmed.startsWith("@")) {
    const aliased = ALIASES[trimmed];
    if (!aliased) {
      throw new Error(`Unknown cron alias "${expr}"`);
    }
    return parseCronExpression(aliased);
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression "${expr}": expected 5 fields, got ${parts.length}`,
    );
  }

  return {
    minute: parseField(parts[0], FIELD_SPECS[0], 0),
    hour: parseField(parts[1], FIELD_SPECS[1], 1),
    dayOfMonth: parseField(parts[2], FIELD_SPECS[2], 2),
    month: parseField(parts[3], FIELD_SPECS[3], 3),
    dayOfWeek: parseField(parts[4], FIELD_SPECS[4], 4),
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Check if a field array represents a wildcard (all values in range). */
function isWildcard(values: number[], spec: FieldSpec): boolean {
  if (values.length !== spec.max - spec.min + 1) return false;
  for (let i = spec.min; i <= spec.max; i++) {
    if (!values.includes(i)) return false;
  }
  return true;
}

/**
 * Check whether a given Date matches the day fields of a CronSchedule.
 * Per POSIX cron standard:
 * - If either day-of-month or day-of-week is *, use AND logic
 * - If both are non-wildcard, use OR logic (fire on either match)
 */
function matchesDayFields(schedule: CronSchedule, date: Date): boolean {
  const domSpec = FIELD_SPECS[2]; // day of month: 1-31
  const dowSpec = FIELD_SPECS[4]; // day of week: 0-6

  const domWildcard = isWildcard(schedule.dayOfMonth, domSpec);
  const dowWildcard = isWildcard(schedule.dayOfWeek, dowSpec);

  const domMatches = schedule.dayOfMonth.includes(date.getDate());
  const dowMatches = schedule.dayOfWeek.includes(date.getDay());

  // Per POSIX: if either field is *, use AND; if both are restricted, use OR
  if (domWildcard || dowWildcard) {
    return domMatches && dowMatches;
  }
  return domMatches || dowMatches;
}

/**
 * Check whether a given Date matches a CronSchedule.
 */
export function matchesCron(schedule: CronSchedule, date: Date): boolean {
  return (
    schedule.minute.includes(date.getMinutes()) &&
    schedule.hour.includes(date.getHours()) &&
    matchesDayFields(schedule, date) &&
    schedule.month.includes(date.getMonth() + 1) // JS months are 0-based
  );
}

// ---------------------------------------------------------------------------
// Next-run calculation
// ---------------------------------------------------------------------------

/**
 * Calculate the next date/time that matches the given schedule,
 * starting from `from` (defaults to now). The returned date is always
 * strictly after `from`.
 *
 * Searches up to ~4 years ahead before giving up.
 */
export function getNextRun(schedule: CronSchedule, from?: Date): Date {
  const start = from ? new Date(from) : new Date();

  // Advance to the next minute boundary
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  // Safety limit: don't search more than ~4 years ahead
  const limit = new Date(start);
  limit.setFullYear(limit.getFullYear() + 4);

  const candidate = new Date(start);

  while (candidate < limit) {
    // Check month
    if (!schedule.month.includes(candidate.getMonth() + 1)) {
      // Advance to first day of next month
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    // Check day fields using POSIX OR logic when both are non-wildcard
    if (!matchesDayFields(schedule, candidate)) {
      // Advance to next day
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    // Check hour
    if (!schedule.hour.includes(candidate.getHours())) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }

    // Check minute
    if (!schedule.minute.includes(candidate.getMinutes())) {
      candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
      continue;
    }

    // All fields match
    return new Date(candidate);
  }

  throw new Error("Could not find next run within 4 years");
}
