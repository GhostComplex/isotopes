import type { AgentEvent } from "@mariozechner/pi-agent-core";

export type MessageSource = "channel" | "tui" | "ui" | "cron" | "heartbeat" | "spawn";

export interface Message {
  agentId: string;
  sessionKey?: string;
  content: string;
  source: MessageSource;
  sender?: string;
  timestamp?: number;
  cwd?: string;
  extraSystemPrompt?: string;
}

export interface DispatchCallbacks {
  onTextDelta?: (delta: string) => void;
  onToolStart?: (call: { id: string; name: string; args: unknown }) => void;
  onToolEnd?: (result: { id: string; name: string; result: unknown; isError: boolean }) => void;
  onEvent?: (event: AgentEvent) => void;
}

export interface DispatchResult {
  sessionId: string;
  state: "started" | "queued";
  responseText: string;
  errorMessage: string | null;
}

export interface Gateway {
  dispatch(msg: Message, callbacks?: DispatchCallbacks): Promise<DispatchResult>;
  abort(sessionId: string, reason?: string): Promise<void>;
}
