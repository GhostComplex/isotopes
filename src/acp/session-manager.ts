// src/acp/session-manager.ts — ACP session lifecycle management
// In-memory session store for ACP agent sessions with event notification.
// Supports optional disk persistence for surviving restarts (#195).

import { randomUUID } from "node:crypto";
import { createLogger } from "../core/logger.js";
import { AcpSessionPersistence } from "./persistence.js";
import type {
  AcpConfig,
  AcpMessage,
  AcpPersistenceConfig,
  AcpSession,
  AcpSessionCallback,
  AcpSessionStatus,
} from "./types.js";

const log = createLogger("acp-session");

/**
 * AcpSessionManager — manages the lifecycle of ACP agent sessions.
 *
 * Responsibilities:
 * - Create / get / update / terminate sessions
 * - Maintain message history per session
 * - Thread ↔ session lookup
 * - Emit lifecycle events for downstream consumers
 * - Optionally persist sessions to disk for restart survival (#195)
 */
export class AcpSessionManager {
  private sessions: Map<string, AcpSession> = new Map();
  private threadIndex: Map<string, string> = new Map(); // threadId → sessionId
  private listeners: AcpSessionCallback[] = [];
  private persistence: AcpSessionPersistence | null = null;

  constructor(private config: AcpConfig) {}

  // -------------------------------------------------------------------------
  // Initialization (#195)
  // -------------------------------------------------------------------------

  /**
   * Initialize the manager with optional persistence.
   * When persistence is configured, restores sessions from disk.
   * Call this before using the manager if persistence is desired.
   */
  async init(persistenceConfig?: AcpPersistenceConfig): Promise<void> {
    if (!persistenceConfig?.enabled) return;

    this.persistence = new AcpSessionPersistence(persistenceConfig);
    await this.persistence.init();

    // Restore sessions from disk
    const { sessions, threadIndex } = await this.persistence.loadAll();
    this.sessions = sessions;
    this.threadIndex = threadIndex;

    // Lazily load message histories for restored sessions
    for (const session of this.sessions.values()) {
      if (session.history.length === 0) {
        session.history = await this.persistence.loadMessages(session.id);
      }
    }

    // Start periodic stale session cleanup
    this.persistence.startCleanupTimer(async () => { await this.cleanupStaleSessions(); });

    log.info(
      `Initialized with persistence (${this.sessions.size} session(s) restored, ` +
      `TTL=${persistenceConfig.ttl}s)`,
    );
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /**
   * Remove terminated sessions from memory (and disk if persistence is enabled).
   * Returns the number of sessions removed.
   */
  purgeTerminated(): number {
    let count = 0;
    for (const [id, session] of this.sessions) {
      if (session.status === "terminated") {
        if (session.threadId) this.threadIndex.delete(session.threadId);
        this.sessions.delete(id);
        if (this.persistence) {
          void this.persistence.deleteTranscript(id);
        }
        count++;
      }
    }
    if (count > 0 && this.persistence) {
      void this.persistence.persistIndex(this.sessions, this.threadIndex);
    }
    return count;
  }

  /**
   * Remove stale sessions (TTL-expired or terminated).
   * Returns the IDs of removed sessions.
   */
  async cleanupStaleSessions(): Promise<string[]> {
    if (!this.persistence) return [];

    const staleIds = this.persistence.findStaleSessions(this.sessions);
    if (staleIds.length === 0) return [];

    for (const id of staleIds) {
      const session = this.sessions.get(id);
      if (session?.threadId) this.threadIndex.delete(session.threadId);
      this.sessions.delete(id);
    }

    await this.persistence.persistIndex(this.sessions, this.threadIndex);
    await Promise.allSettled(
      staleIds.map((id) => this.persistence!.deleteTranscript(id)),
    );

    log.info(`Cleaned up ${staleIds.length} stale ACP session(s)`);
    return staleIds;
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** Get the ACP configuration this manager was created with. */
  getConfig(): AcpConfig {
    return this.config;
  }

  // -------------------------------------------------------------------------
  // Session CRUD
  // -------------------------------------------------------------------------

  /**
   * Create a new ACP session for the given agent.
   * Validates that the agent is in the allowedAgents list (if configured).
   */
  createSession(agentId: string, threadId?: string): AcpSession {
    if (
      this.config.allowedAgents &&
      this.config.allowedAgents.length > 0 &&
      !this.config.allowedAgents.includes(agentId)
    ) {
      throw new Error(
        `Agent "${agentId}" is not in the allowedAgents list`,
      );
    }

    const now = new Date();
    const session: AcpSession = {
      id: randomUUID(),
      agentId,
      threadId,
      status: "active",
      createdAt: now,
      lastActivityAt: now,
      history: [],
    };

    this.sessions.set(session.id, session);
    if (threadId) this.threadIndex.set(threadId, session.id);
    this.notify(session, "created");

    if (this.persistence) {
      void this.persistence.persistIndex(this.sessions, this.threadIndex);
    }

    return session;
  }

  /** Retrieve a session by its ID. */
  getSession(sessionId: string): AcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Find the session bound to a given Discord thread ID. */
  getSessionByThread(threadId: string): AcpSession | undefined {
    const sessionId = this.threadIndex.get(threadId);
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  /**
   * Partially update a session's mutable fields.
   * Updates lastActivityAt automatically.
   */
  updateSession(
    sessionId: string,
    update: Partial<Pick<AcpSession, "status" | "threadId" | "agentId">>,
  ): AcpSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    if (update.status !== undefined) session.status = update.status;
    if (update.threadId !== undefined) {
      // Update thread index
      if (session.threadId) this.threadIndex.delete(session.threadId);
      if (update.threadId) this.threadIndex.set(update.threadId, sessionId);
      session.threadId = update.threadId;
    }
    if (update.agentId !== undefined) session.agentId = update.agentId;
    session.lastActivityAt = new Date();

    this.notify(session, "updated");

    if (this.persistence) {
      void this.persistence.persistIndex(this.sessions, this.threadIndex);
    }

    return session;
  }

  /**
   * Terminate a session (sets status to "terminated").
   * Returns true if the session existed and was terminated.
   */
  terminateSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.status = "terminated";
    session.lastActivityAt = new Date();
    this.notify(session, "terminated");

    if (this.persistence) {
      void this.persistence.persistIndex(this.sessions, this.threadIndex);
    }

    return true;
  }

  /**
   * List sessions, optionally filtered by agentId and/or status.
   */
  listSessions(filter?: { agentId?: string; status?: AcpSessionStatus }): AcpSession[] {
    const results: AcpSession[] = [];
    for (const session of this.sessions.values()) {
      if (filter?.agentId && session.agentId !== filter.agentId) continue;
      if (filter?.status && session.status !== filter.status) continue;
      results.push(session);
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Message history
  // -------------------------------------------------------------------------

  /**
   * Append a message to a session's history.
   * Updates lastActivityAt. Returns true if the session existed.
   */
  addMessage(
    sessionId: string,
    message: Omit<AcpMessage, "timestamp">,
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const now = new Date();
    const fullMessage: AcpMessage = {
      ...message,
      timestamp: now,
    };
    session.history.push(fullMessage);
    session.lastActivityAt = now;

    this.notify(session, "updated");

    if (this.persistence) {
      void this.persistence.appendMessage(sessionId, fullMessage);
      this.persistence.debouncedPersistIndex(this.sessions, this.threadIndex);
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /**
   * Register a callback for session lifecycle events.
   * Returns an unsubscribe function.
   */
  onSessionEvent(callback: AcpSessionCallback): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /** Release persistence timers and resources. */
  destroy(): void {
    if (this.persistence) {
      this.persistence.destroy();
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private notify(session: AcpSession, event: "created" | "updated" | "terminated"): void {
    for (const listener of this.listeners) {
      listener(session, event);
    }
  }
}
