import type { DaemonStatus, DispatchResult, SessionInfo, SessionItem } from "./types.js";
import type { SessionEvent } from "../gateway/types.js";
import { apiFetch, getBaseUrl } from "../utils/api-client.js";

function sessionPath(agentId: string, sessionKey?: string): string {
  const base = `/api/sessions/${encodeURIComponent(agentId)}`;
  return sessionKey ? `${base}/${encodeURIComponent(sessionKey)}` : base;
}

export async function getStatus(): Promise<DaemonStatus> {
  return apiFetch<DaemonStatus>("GET", "/api/status");
}

export async function isDaemonRunning(): Promise<boolean> {
  try {
    await getStatus();
    return true;
  } catch {
    return false;
  }
}

export async function getSessions(): Promise<SessionItem[]> {
  const data = await apiFetch<{ items: SessionItem[] }>("GET", "/api/sessions");
  return data.items;
}

export async function createSession(agentId: string, sessionKey?: string): Promise<SessionInfo> {
  const body: Record<string, string> = {};
  if (sessionKey !== undefined) body.sessionKey = sessionKey;
  return apiFetch<SessionInfo>("POST", sessionPath(agentId), body);
}

export async function deleteSession(agentId: string, sessionKey: string): Promise<void> {
  await apiFetch("DELETE", sessionPath(agentId, sessionKey));
}

export async function abortSession(agentId: string, sessionKey: string): Promise<void> {
  await apiFetch("POST", `${sessionPath(agentId, sessionKey)}/abort`);
}

export async function getMessages(agentId: string, sessionKey: string): Promise<{ items: Array<{ role: string; content?: unknown; timestamp?: number }> }> {
  return apiFetch("GET", `${sessionPath(agentId, sessionKey)}/messages`);
}

export async function dispatch(
  agentId: string,
  sessionKey: string,
  message: string,
): Promise<DispatchResult> {
  return apiFetch<DispatchResult>("POST", `${sessionPath(agentId, sessionKey)}/dispatch`, { message });
}

// ---------------------------------------------------------------------------
// SSE streaming
// ---------------------------------------------------------------------------

async function* parseSSE(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let dataLines: string[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
        dataLines = [];
      } else if (line.startsWith("data: ")) {
        dataLines.push(line.slice(6));
      } else if (line === "" && currentEvent && dataLines.length > 0) {
        if (currentEvent !== "ping" && currentEvent !== "connected") {
          yield { event: currentEvent, data: dataLines.join("\n") };
        }
        currentEvent = "";
        dataLines = [];
      }
    }
  }
}

export async function subscribe(
  agentId: string,
  sessionKey: string,
  onEvent: (event: SessionEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`${getBaseUrl()}${sessionPath(agentId, sessionKey)}/stream`, { signal });
  if (!res.ok) throw new Error(`API stream: ${res.status} ${res.statusText}`);
  const reader = res.body!.getReader();
  for await (const { data } of parseSSE(reader)) {
    try { onEvent(JSON.parse(data) as SessionEvent); } catch { /* malformed JSON */ }
  }
}
