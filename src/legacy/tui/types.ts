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

/** Mirrors gateway/types.ts SessionEvent — wire shape over SSE. */
export type StreamEvent =
  | { type: "user_message"; message: unknown; messageId: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_result"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "assistant_message"; message: unknown; messageId: string }
  | { type: "turn_end" }
  | { type: "agent_end"; stopReason: "end" | "error"; errorMessage?: string };

export type Screen = "chat" | "status" | "sessions";

export interface TuiOptions {
  agent?: string;
}
