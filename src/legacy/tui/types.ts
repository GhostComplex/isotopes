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

export type SSEEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_result"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "turn_end" }
  | { type: "error"; message: string };

export type Screen = "chat" | "status";

export interface TuiOptions {
  agent?: string;
  /** Attach to an existing session by key instead of creating the default `tui` session. */
  session?: string;
}
