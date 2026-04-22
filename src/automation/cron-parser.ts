import { Cron } from "croner";

export interface CronSchedule {
  _cron: Cron;
}

const ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

export function parseCronExpression(expr: string): CronSchedule {
  const trimmed = expr.trim().toLowerCase();
  const resolved = trimmed.startsWith("@") ? ALIASES[trimmed] : trimmed;
  if (!resolved) {
    throw new Error(`Unknown cron alias "${expr}"`);
  }

  const parts = resolved.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression "${expr}": expected 5 fields, got ${parts.length}`,
    );
  }

  return { _cron: new Cron(resolved, { paused: true }) };
}

export function matchesCron(schedule: CronSchedule, date: Date): boolean {
  return schedule._cron.match(date);
}

export function getNextRun(schedule: CronSchedule, from?: Date): Date {
  const start = from ? new Date(from) : new Date();

  const next = schedule._cron.nextRun(start);
  if (!next) {
    throw new Error("Could not find next run within search range");
  }
  return next;
}
