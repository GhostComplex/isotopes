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

export type Screen = "chat" | "status";

export interface TuiOptions {
  agent?: string;
  config?: string;
  message?: string;
}
