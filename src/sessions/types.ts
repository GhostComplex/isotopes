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
  /** If true, session is exempt from TTL-based cleanup */
  persistent?: boolean;
}

/** Session TTL and cleanup configuration */
export interface SessionConfig {
  /** Session time-to-live in seconds. Default: 86400 (24 hours) */
  ttl?: number;
  /** Interval between cleanup sweeps in seconds. Default: 3600 (1 hour) */
  cleanupInterval?: number;
}

/** Configuration for the session store (data directory, limits, TTL). */
export interface SessionStoreConfig {
  dataDir: string;
  maxSessions?: number;       // default: 100
  maxTotalSizeMB?: number;    // default: 100
  session?: SessionConfig;
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
  setMessages(sessionId: string, messages: AgentMessage[]): Promise<void>;
  setMetadata(sessionId: string, patch: Partial<SessionMetadata>): Promise<void>;
  /** Get the underlying SDK SessionManager for a session (for AgentSession creation). */
  getSessionManager(sessionId: string): Promise<import("@mariozechner/pi-coding-agent").SessionManager | undefined>;
}
