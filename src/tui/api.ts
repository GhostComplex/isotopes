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

// -- Status / monitoring (existing) --

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

// -- Chat session management --

export async function createSession(agentId?: string, sessionKey?: string): Promise<ChatSessionInfo> {
  return postJson<ChatSessionInfo>("/api/chat/sessions", { agentId, sessionKey });
}

export async function listChatSessions(): Promise<{ sessions: { sessionId: string; agentId: string; lastActivity: number }[] }> {
  return fetchJson("/api/chat/sessions");
}

export async function getHistory(sessionId: string): Promise<{ messages: Array<{ role: string; content?: unknown; timestamp?: number }> }> {
  return fetchJson(`/api/chat/sessions/${sessionId}/messages`);
}

export async function abortMessage(sessionId: string): Promise<void> {
  await postJson(`/api/chat/sessions/${sessionId}/abort`);
}

export async function deleteSession(sessionId: string): Promise<void> {
  await deleteJson(`/api/chat/sessions/${sessionId}`);
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
  sessionId: string,
  message: string,
  onEvent: (event: SSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/api/chat/sessions/${sessionId}/message`, {
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

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const event = parseSSELine(currentEvent, line.slice(6));
        if (event) onEvent(event);
        currentEvent = "";
      }
    }
  }
}
