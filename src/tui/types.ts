export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; args: string; result?: string; isError?: boolean };

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  blocks?: ContentBlock[];
  timestamp: Date;
  id?: string;
}

export interface DaemonStatus {
  version: string;
  uptime: number;
  cronJobs: number;
}

export interface SessionSummary {
  key: string;
  agentId: string;
  status: string;
  lastActivityAt: string;
}

export interface ChatSessionInfo {
  key: string;
  agentId: string;
  resumed: boolean;
}

export interface DispatchAck {
  sessionId: string;
  state: "new_run" | "steered";
}

export type { SessionEvent as StreamEvent } from "../gateway/types.js";

export type Screen = "chat" | "status" | "sessions";

export interface TuiOptions {
  agent?: string;
}
