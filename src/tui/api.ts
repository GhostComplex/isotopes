import type { ChatSessionInfo, DaemonStatus, SessionSummary, SSEEvent, UsageStats } from "./types.js";

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

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API ${path}: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function deleteJson<T>(path: string): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`API ${path}: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

function sessionPath(agentId: string, sessionKey?: string): string {
  const base = `/api/sessions/${encodeURIComponent(agentId)}`;
  return sessionKey ? `${base}/${encodeURIComponent(sessionKey)}` : base;
}

// -- Status / monitoring --

export async function fetchStatus(): Promise<DaemonStatus> {
  return fetchJson<DaemonStatus>("/api/status");
}

export async function fetchSessions(): Promise<SessionSummary[]> {
  const data = await fetchJson<{ items: SessionSummary[] }>("/api/sessions");
  return data.items;
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

// -- Session management --

export async function createSession(agentId: string, sessionKey?: string): Promise<ChatSessionInfo> {
  const body: Record<string, string> = {};
  if (sessionKey !== undefined) body.sessionKey = sessionKey;
  return postJson<ChatSessionInfo>(sessionPath(agentId), body);
}

export async function getHistory(agentId: string, sessionKey: string): Promise<{ items: Array<{ role: string; content?: unknown; timestamp?: number }> }> {
  return fetchJson(`${sessionPath(agentId, sessionKey)}/messages`);
}

export async function abortMessage(agentId: string, sessionKey: string): Promise<void> {
  await postJson(`${sessionPath(agentId, sessionKey)}/abort`);
}

export async function deleteSession(agentId: string, sessionKey: string): Promise<void> {
  await deleteJson(sessionPath(agentId, sessionKey));
}

// -- SSE streaming --

export function parseSSELine(eventType: string, data: string): SSEEvent | null {
  if (!eventType || !data) return null;
  try {
    const parsed = JSON.parse(data);
    switch (eventType) {
      case "text_delta":
        return { type: "text_delta", text: parsed.text };
      case "tool_call":
        return { type: "tool_call", toolCallId: parsed.toolCallId, toolName: parsed.toolName, args: parsed.args };
      case "tool_result":
        return { type: "tool_result", toolCallId: parsed.toolCallId, toolName: parsed.toolName, result: parsed.result, isError: parsed.isError };
      case "error":
        return { type: "error", message: parsed.message };
      case "agent_end":
        return { type: "agent_end", stopReason: parsed.stopReason };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export async function sendMessage(
  agentId: string,
  sessionKey: string,
  message: string,
  onEvent: (event: SSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${getBaseUrl()}${sessionPath(agentId, sessionKey)}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`API chat message: ${res.status} ${res.statusText}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let dataLines: string[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
        dataLines = [];
      } else if (line.startsWith("data: ")) {
        dataLines.push(line.slice(6));
      } else if (line === "") {
        if (currentEvent && dataLines.length > 0) {
          const event = parseSSELine(currentEvent, dataLines.join("\n"));
          if (event) onEvent(event);
        }
        currentEvent = "";
        dataLines = [];
      }
    }
  }
}
