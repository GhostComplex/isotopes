// src/sessions/types.ts — Session storage contract

import type { AgentMessage } from "@mariozechner/pi-agent-core";

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
  /**
   * Atomic find-by-key-or-create. Concurrent calls with the same key
   * coalesce to one underlying create — the alternative
   * `(await findByKey(k)) ?? (await create(...))` racing pattern throws
   * "Session with key already exists" under parallel access.
   */
  findOrCreateByKey(key: string, agentId: string, metadata?: Omit<SessionMetadata, "key">): Promise<Session>;
  get(sessionId: string): Promise<Session | undefined>;
  findByKey(key: string): Promise<Session | undefined>;
  addMessage(sessionId: string, message: AgentMessage): Promise<void>;
  getMessages(sessionId: string): Promise<AgentMessage[]>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<Session[]>;
  clearMessages(sessionId: string): Promise<void>;
  /** Get the underlying SDK SessionManager for a session (for AgentSession creation). */
  getSessionManager(sessionId: string): Promise<import("@mariozechner/pi-coding-agent").SessionManager | undefined>;
}
