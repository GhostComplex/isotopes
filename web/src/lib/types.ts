export interface Agent {
  id: string;
  name: string;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
  output?: string;
  isError?: boolean;
}

export type SSEEvent =
  | { type: "session"; sessionId: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; output: string; isError: boolean }
  | { type: "done"; sessionId: string }
  | { type: "error"; error: string };
