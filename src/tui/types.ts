export type ContentItem =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; args: string; completed?: boolean; isError?: boolean };

export interface TuiMessage {
  role: "user" | "assistant" | "system";
  content: ContentItem[];
  timestamp: Date;
  id?: string;
}

export interface DaemonStatus {
  version: string;
  uptime: number;
  cronJobs: number;
}

export interface SessionItem {
  key: string;
  agentId: string;
  status: string;
  lastActivityAt: string;
}

export interface SessionInfo {
  key: string;
  agentId: string;
  resumed: boolean;
}

export interface DispatchResult {
  sessionId: string;
}

export type Screen = "chat" | "status" | "sessions";

export interface TuiOptions {
  agent?: string;
}
