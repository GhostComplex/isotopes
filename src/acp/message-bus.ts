// src/acp/message-bus.ts — Agent-to-agent message bus
// Provides publish/subscribe message routing between agents and sessions.

import { randomUUID } from "node:crypto";
import type { AcpSessionManager } from "./session-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A message sent between agents via the message bus. */
export interface AgentMessage {
  /** Unique message identifier */
  id: string;
  /** Agent ID of the sender */
  fromAgentId: string;
  /** Optional session ID of the sender */
  fromSessionId?: string;
  /** Agent ID of the recipient */
  toAgentId: string;
  /** Optional session ID of the recipient (omit to broadcast to all sessions) */
  toSessionId?: string;
  /** Message content */
  content: string;
  /** Optional structured metadata */
  metadata?: Record<string, unknown>;
  /** When the message was created */
  timestamp: Date;
}

/** Result of delivering a single message. */
export interface MessageDelivery {
  /** ID of the message that was delivered */
  messageId: string;
  /** Whether the message was delivered to at least one handler */
  delivered: boolean;
  /** Session ID the message was delivered to (if applicable) */
  sessionId?: string;
  /** Error message if delivery failed */
  error?: string;
}

/** Callback invoked when a message is received. */
export type MessageHandler = (message: AgentMessage) => void | Promise<void>;

// ---------------------------------------------------------------------------
// AgentMessageBus
// ---------------------------------------------------------------------------

/**
 * AgentMessageBus — in-memory pub/sub message bus for agent-to-agent
 * and session-to-session communication.
 *
 * Supports:
 * - Sending to a specific agent (all handlers for that agent)
 * - Sending to a specific session
 * - Broadcasting to every registered agent
 * - Pending-message queue per agent/session
 * - Optional AcpSessionManager integration for session-aware routing
 */
/** Maximum number of pending messages per agent/session before oldest are dropped. */
const MAX_PENDING_MESSAGES = 100;

export class AgentMessageBus {
  /** agentId → handlers */
  private agentHandlers: Map<string, MessageHandler[]> = new Map();
  /** sessionId → handlers */
  private sessionHandlers: Map<string, MessageHandler[]> = new Map();
  /** agentId → pending messages (queue model) */
  private pendingByAgent: Map<string, AgentMessage[]> = new Map();
  /** sessionId → pending messages (queue model) */
  private pendingBySession: Map<string, AgentMessage[]> = new Map();

  private sessionManager?: AcpSessionManager;

  constructor(sessionManager?: AcpSessionManager) {
    this.sessionManager = sessionManager;
  }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  /**
   * Send a message to a specific agent or session.
   *
   * - If `toSessionId` is set, delivers only to session-level handlers.
   * - Otherwise delivers to all agent-level handlers for `toAgentId`.
   * - Messages with no matching handlers are queued as pending.
   */
  send(
    partial: Omit<AgentMessage, "id" | "timestamp">,
  ): MessageDelivery {
    const message: AgentMessage = {
      ...partial,
      id: randomUUID(),
      timestamp: new Date(),
    };

    // Route to a specific session
    if (message.toSessionId) {
      return this.deliverToSession(message, message.toSessionId);
    }

    // Route to agent-level handlers
    return this.deliverToAgent(message, message.toAgentId);
  }

  // -------------------------------------------------------------------------
  // Broadcast
  // -------------------------------------------------------------------------

  /**
   * Broadcast a message from one agent to **all** registered agents
   * (excluding the sender).
   */
  broadcast(
    fromAgentId: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): MessageDelivery[] {
    const deliveries: MessageDelivery[] = [];

    for (const agentId of this.agentHandlers.keys()) {
      if (agentId === fromAgentId) continue;

      const delivery = this.send({
        fromAgentId,
        toAgentId: agentId,
        content,
        metadata,
      });
      deliveries.push(delivery);
    }

    return deliveries;
  }

  // -------------------------------------------------------------------------
  // Subscribe
  // -------------------------------------------------------------------------

  /**
   * Subscribe to messages destined for a given agent.
   * Returns an unsubscribe function.
   */
  subscribe(agentId: string, handler: MessageHandler): () => void {
    const handlers = this.agentHandlers.get(agentId) ?? [];
    handlers.push(handler);
    this.agentHandlers.set(agentId, handlers);

    // Flush any pending messages
    this.flushPendingAgent(agentId, handler);

    return () => {
      const list = this.agentHandlers.get(agentId);
      if (!list) return;
      const idx = list.indexOf(handler);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) this.agentHandlers.delete(agentId);
    };
  }

  /**
   * Subscribe to messages destined for a specific session.
   * Returns an unsubscribe function.
   */
  subscribeSession(sessionId: string, handler: MessageHandler): () => void {
    const handlers = this.sessionHandlers.get(sessionId) ?? [];
    handlers.push(handler);
    this.sessionHandlers.set(sessionId, handlers);

    // Flush any pending messages
    this.flushPendingSession(sessionId, handler);

    return () => {
      const list = this.sessionHandlers.get(sessionId);
      if (!list) return;
      const idx = list.indexOf(handler);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) this.sessionHandlers.delete(sessionId);
    };
  }

  // -------------------------------------------------------------------------
  // Pending messages (queue model)
  // -------------------------------------------------------------------------

  /**
   * Get pending (un-delivered) messages for an agent or session.
   * Optionally filters by sessionId.
   */
  getPending(agentId: string, sessionId?: string): AgentMessage[] {
    if (sessionId) {
      return [...(this.pendingBySession.get(sessionId) ?? [])];
    }
    return [...(this.pendingByAgent.get(agentId) ?? [])];
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private deliverToAgent(message: AgentMessage, agentId: string): MessageDelivery {
    const handlers = this.agentHandlers.get(agentId);

    if (!handlers || handlers.length === 0) {
      // Queue as pending (capped to avoid unbounded growth)
      const pending = this.pendingByAgent.get(agentId) ?? [];
      pending.push(message);
      if (pending.length > MAX_PENDING_MESSAGES) {
        pending.splice(0, pending.length - MAX_PENDING_MESSAGES);
      }
      this.pendingByAgent.set(agentId, pending);

      return {
        messageId: message.id,
        delivered: false,
      };
    }

    for (const handler of handlers) {
      handler(message);
    }

    return {
      messageId: message.id,
      delivered: true,
    };
  }

  private deliverToSession(message: AgentMessage, sessionId: string): MessageDelivery {
    const handlers = this.sessionHandlers.get(sessionId);

    if (!handlers || handlers.length === 0) {
      // Queue as pending (capped to avoid unbounded growth)
      const pending = this.pendingBySession.get(sessionId) ?? [];
      pending.push(message);
      if (pending.length > MAX_PENDING_MESSAGES) {
        pending.splice(0, pending.length - MAX_PENDING_MESSAGES);
      }
      this.pendingBySession.set(sessionId, pending);

      return {
        messageId: message.id,
        delivered: false,
        sessionId,
      };
    }

    for (const handler of handlers) {
      handler(message);
    }

    return {
      messageId: message.id,
      delivered: true,
      sessionId,
    };
  }

  private flushPendingAgent(agentId: string, handler: MessageHandler): void {
    const pending = this.pendingByAgent.get(agentId);
    if (!pending || pending.length === 0) return;

    for (const message of pending) {
      handler(message);
    }
    this.pendingByAgent.delete(agentId);
  }

  private flushPendingSession(sessionId: string, handler: MessageHandler): void {
    const pending = this.pendingBySession.get(sessionId);
    if (!pending || pending.length === 0) return;

    for (const message of pending) {
      handler(message);
    }
    this.pendingBySession.delete(sessionId);
  }
}
