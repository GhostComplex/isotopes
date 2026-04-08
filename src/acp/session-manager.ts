// src/acp/session-manager.ts — ACP session lifecycle management
// In-memory session store for ACP agent sessions with event notification.

import { randomUUID } from "node:crypto";
import type {
  AcpConfig,
  AcpMessage,
  AcpSession,
  AcpSessionCallback,
  AcpSessionStatus,
} from "./types.js";

/**
 * AcpSessionManager — manages the lifecycle of ACP agent sessions.
 *
 * Responsibilities:
 * - Create / get / update / terminate sessions
 * - Maintain message history per session
 * - Thread ↔ session lookup
 * - Emit lifecycle events for downstream consumers
 *
 * Storage is in-memory for now; persistence can be added later.
 */
export class AcpSessionManager {
  private sessions: Map<string, AcpSession> = new Map();
  private listeners: AcpSessionCallback[] = [];

  constructor(private config: AcpConfig) {}

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
    // Validate agent is allowed
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
    this.notify(session, "created");

    return session;
  }

  /** Retrieve a session by its ID. */
  getSession(sessionId: string): AcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Find the session bound to a given Discord thread ID. */
  getSessionByThread(threadId: string): AcpSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.threadId === threadId) {
        return session;
      }
    }
    return undefined;
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
    if (update.threadId !== undefined) session.threadId = update.threadId;
    if (update.agentId !== undefined) session.agentId = update.agentId;
    session.lastActivityAt = new Date();

    this.notify(session, "updated");
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

    session.history.push({
      ...message,
      timestamp: new Date(),
    });
    session.lastActivityAt = new Date();

    this.notify(session, "updated");
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
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
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
