import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Session } from "../agent/types.js";

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

export interface DispatchResult {
  sessionId: string;
}

export interface CreateSessionResult {
  sessionId: string;
  sessionKey: string;
  resumed: boolean;
}

/** text_delta (streaming) and assistant_message (finalized) intentionally overlap. */
export type SessionEvent =
  | { type: "user_message"; message: AgentMessage; messageId: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_result"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "assistant_message"; message: AgentMessage; messageId: string }
  | { type: "turn_end" }
  | { type: "agent_end"; stopReason: "end" | "error"; errorMessage?: string };

export type SessionEventListener = (event: SessionEvent) => void;

export interface AwaitResult {
  responseText: string;
  errorMessage: string | null;
}

export interface Gateway {
  /** Fire-and-forget. Resolves once the run is registered and emitting.
   *  Throws if the same session already has a run in flight — callers must
   *  serialize (e.g. KeyedAsyncQueue) or steer via trySteer first. */
  dispatch(msg: Message): Promise<DispatchResult>;

  /** Sync in-turn steer. Returns true iff the content was queued into the
   *  active turn; false if no active run or it's not currently streaming.
   *  On false, fall back to dispatch. */
  trySteer(agentId: string, sessionKey: string, content: string): boolean;

  /** Convenience: dispatch + subscribe + wait for agent_end, returns final text. */
  dispatchAndWait(msg: Message): Promise<AwaitResult>;

  abort(sessionId: string, reason?: string): Promise<void>;
  /** Resolves sessionKey via store; returns false if no such session. */
  abortByKey(agentId: string, sessionKey: string, reason?: string): Promise<boolean>;

  agentExists(agentId: string): boolean;

  listSessions(): Promise<Session[]>;
  getSession(agentId: string, sessionKey: string): Promise<Session | undefined>;
  getMessages(agentId: string, sessionKey: string): Promise<AgentMessage[] | undefined>;
  /** Subscribe to all events for a session. Returns unsubscribe, or undefined if session not found. */
  subscribe(
    agentId: string,
    sessionKey: string,
    listener: SessionEventListener,
  ): Promise<(() => void) | undefined>;

  createOrResumeSession(agentId: string, sessionKey?: string): Promise<CreateSessionResult>;
  deleteSession(agentId: string, sessionKey: string): Promise<boolean>;
}
