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
  cwd?: string;
  extraSystemPrompt?: string;
  images?: InboundImage[];
}

export interface DispatchCallbacks {
  onTextDelta?: (delta: string) => void;
  onToolStart?: (call: { id: string; name: string; args: unknown }) => void;
  onToolEnd?: (result: { id: string; name: string; result: unknown; isError: boolean }) => void;
  /** Fires on each turn boundary inside the run. SSE bridges use this to
   * emit a `turn_end` event so clients can rotate streaming buffers. */
  onTurnEnd?: () => void;
}

export interface DispatchResult {
  sessionId: string;
  state: "started" | "queued";
  responseText: string;
  errorMessage: string | null;
}

export interface Gateway {
  dispatch(msg: Message, callbacks?: DispatchCallbacks): Promise<DispatchResult>;
  abort(sessionId: string, reason?: string): Promise<void>;
  /** Resolves sessionKey via store; returns false if no such session. */
  abortByKey(agentId: string, sessionKey: string, reason?: string): Promise<boolean>;
}
