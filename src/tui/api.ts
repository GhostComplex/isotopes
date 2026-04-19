import type { DaemonStatus, SessionSummary, UsageStats } from "./types.js";

const DEFAULT_PORT = 2712;

function getBaseUrl(): string {
  const port = process.env.ISOTOPES_PORT
    ? parseInt(process.env.ISOTOPES_PORT, 10)
    : DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`);
  if (!res.ok) throw new Error(`API ${path}: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export async function fetchStatus(): Promise<DaemonStatus> {
  return fetchJson<DaemonStatus>("/api/status");
}

export async function fetchSessions(): Promise<SessionSummary[]> {
  return fetchJson<SessionSummary[]>("/api/sessions");
}

export async function fetchUsage(): Promise<UsageStats> {
  return fetchJson<UsageStats>("/api/usage");
}

export async function isDaemonRunning(): Promise<boolean> {
  try {
    await fetchStatus();
    return true;
  } catch {
    return false;
  }
}
