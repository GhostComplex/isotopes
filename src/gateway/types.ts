import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Session, TranscriptListener } from "../sessions/types.js";

export type { Session, SessionMetadata, TranscriptListener } from "../sessions/types.js";

export type MessageSource = "channel" | "tui" | "ui" | "cron" | "heartbeat" | "spawn";

/** Image attachment shape — base64 data with MIME type. Mirrors pi-ai ImageContent. */
export interface InboundImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface Message {
  agentId: string;
  sessionKey?: string;
  content: string;
  source: MessageSource;
  sender?: string;
  timestamp?: number;
  extraSystemPrompt?: string;
  images?: InboundImage[];
}

export interface DispatchCallbacks {
  onTextDelta?: (delta: string) => void;
  onToolStart?: (call: { id: string; name: string; args: unknown }) => void;
  onToolEnd?: (result: { id: string; name: string; result: unknown; isError: boolean }) => void;
  onTurnEnd?: () => void;
}

export interface DispatchResult {
  sessionId: string;
  state: "new_run" | "steered";
  responseText: string;
  errorMessage: string | null;
}

export interface CreateSessionResult {
  sessionId: string;
  sessionKey: string;
  resumed: boolean;
}

export interface Gateway {
  dispatch(msg: Message, callbacks?: DispatchCallbacks): Promise<DispatchResult>;
  abort(sessionId: string, reason?: string): Promise<void>;
  /** Resolves sessionKey via store; returns false if no such session. */
  abortByKey(agentId: string, sessionKey: string, reason?: string): Promise<boolean>;

  agentExists(agentId: string): boolean;

  listSessions(): Promise<Session[]>;
  listSessionsForAgent(agentId: string): Promise<Session[]>;
  getSession(agentId: string, sessionKey: string): Promise<Session | undefined>;
  getMessages(agentId: string, sessionKey: string): Promise<AgentMessage[] | undefined>;
  subscribeMessages(
    agentId: string,
    sessionKey: string,
    listener: TranscriptListener,
  ): Promise<(() => void) | undefined>;

  createOrResumeSession(agentId: string, sessionKey?: string): Promise<CreateSessionResult>;
  deleteSession(agentId: string, sessionKey: string): Promise<boolean>;
}
