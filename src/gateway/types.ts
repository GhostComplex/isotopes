import type { AgentEvent } from "@mariozechner/pi-agent-core";

export type MessageSource = "channel" | "tui" | "ui" | "cron" | "spawn";

export interface Message {
  agentId: string;
  /** Omit to create a fresh session each call. */
  sessionKey?: string;
  content: string;
  source: MessageSource;
  sender?: string;
  timestamp?: number;
  cwd?: string;
  extraSystemPrompt?: string;
}

export interface SendResult {
  state: "started" | "buffered";
  sessionId: string;
  /** Set only when buffered. */
  queueDepth?: number;
}

export interface SendAndWaitResult {
  responseText: string;
  errorMessage: string | null;
  sessionId: string;
}

export interface EventFilter {
  sessionId?: string;
  agentId?: string;
}

export type EventHandler = (event: AgentEvent) => void;
export type Unsubscribe = () => void;

export interface Gateway {
  send(msg: Message): Promise<SendResult>;
  /** send + wait for agent_end + return collected text. */
  sendAndWait(msg: Message): Promise<SendAndWaitResult>;
  events: {
    subscribe(filter: EventFilter, handler: EventHandler): Unsubscribe;
  };
  abort(sessionId: string, reason?: string): Promise<void>;
}
