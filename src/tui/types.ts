export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: ToolCallEntry[];
  timestamp: Date;
}

export interface ToolCallEntry {
  id: string;
  name: string;
  args: string;
  result?: string;
  isError?: boolean;
}

export interface DaemonStatus {
  version: string;
  uptime: number;
  cronJobs: number;
}

export interface SessionSummary {
  id: string;
  agentId: string;
  source: string;
  status: string;
  lastActivityAt: string;
}

export interface UsageStats {
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface ChatSessionInfo {
  sessionId: string;
  agentId: string;
  resumed: boolean;
}

export type SSEEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_result"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "error"; message: string }
  | { type: "agent_end"; stopReason: string };

export type Screen = "chat" | "status";

export interface TuiOptions {
  agent?: string;
  config?: string;
  message?: string;
}
