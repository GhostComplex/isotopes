// src/sessions/types.ts — Session storage contract

import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** Per-message append notification for transcript-bus subscribers. */
export interface TranscriptUpdate {
  sessionId: string;
  message: AgentMessage;
  messageId: string;
}

export type TranscriptListener = (update: TranscriptUpdate) => void;

/** A conversation session binding an agent to a transport channel. */
export interface Session {
  id: string;
  agentId: string;
  metadata?: SessionMetadata;
  lastActiveAt: Date;
}

/**
 * Session metadata. `transport` is set for sessions originating from a chat
 * transport (discord/web).
 */
export interface SessionMetadata {
  key?: string;                        // Unique key for session lookup (e.g., discord:{botId}:channel:{id}:{agentId})
  transport?: string;
  channelId?: string;
  channelName?: string;
  guildName?: string;
  threadId?: string;
}

/** Persistent store for sessions and their message histories. */
export interface SessionStore {
  create(agentId: string, metadata?: SessionMetadata): Promise<Session>;
  get(sessionId: string): Promise<Session | undefined>;
  findByKey(key: string): Promise<Session | undefined>;
  addMessage(sessionId: string, message: AgentMessage): Promise<void>;
  getMessages(sessionId: string): Promise<AgentMessage[]>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<Session[]>;
  clearMessages(sessionId: string): Promise<void>;
  /** Get the underlying SDK SessionManager for a session (for AgentSession creation). */
  getSessionManager(sessionId: string): Promise<import("@mariozechner/pi-coding-agent").SessionManager | undefined>;
  /** Subscribe to transcript appends for a sessionId. Multiple listeners allowed.
   * Returns an unsubscribe function. */
  attach(sessionId: string, listener: TranscriptListener): () => void;
}
