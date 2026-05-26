import { apiFetch, ApiError } from "../utils/api-client.js";

export function requireArg(value: string | undefined, usage: string): string {
  if (!value) {
    console.error(`Usage: ${usage}`);
    process.exit(1);
  }
  return value;
}

export async function withDaemonErrors(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof TypeError && String(err).includes("fetch")) {
      console.error("Cannot connect to daemon. Is it running? Run `isotopes` in the foreground or via the LaunchAgent.");
    } else {
      console.error("Error:", err instanceof Error ? err.message : err);
    }
    process.exit(1);
  }
}

export async function apiAction(opts: {
  method: string;
  path: string;
  body?: unknown;
  notFoundLabel: string;
  notFoundId: string;
  success: string;
}): Promise<void> {
  try {
    await apiFetch(opts.method, opts.path, opts.body);
    console.log(opts.success);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      console.error(`${opts.notFoundLabel} not found: ${opts.notFoundId}`);
      process.exit(1);
    }
    throw err;
  }
}

export function printJsonOr(json: boolean, data: unknown, fallback: () => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    fallback();
  }
}
