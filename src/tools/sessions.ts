// src/tools/sessions.ts — ACP session tools for inter-agent communication
// Exposes AcpSessionManager and AgentMessageBus to agents as callable tools.

import { createLogger } from "../core/logger.js";
import type { Tool } from "../core/types.js";
import type { ToolHandler } from "../core/tools.js";
import type { AcpSessionManager } from "../acp/session-manager.js";
import type { AgentMessageBus, AgentMessage } from "../acp/message-bus.js";

const log = createLogger("tools:sessions");

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** Context required by session tools at runtime. */
export interface SessionsToolContext {
  sessionManager: AcpSessionManager;
  messageBus: AgentMessageBus;
  /** Agent ID of the calling agent */
  currentAgentId: string;
  /** Session ID of the calling agent's current session */
  currentSessionId?: string;
}

// ---------------------------------------------------------------------------
// sessions_spawn
// ---------------------------------------------------------------------------

/**
 * Create the `sessions_spawn` tool.
 *
 * Wraps AcpSessionManager.createSession() — lets an agent create a new ACP
 * session for communication with another agent.
 */
export function createSessionsSpawnTool(
  ctx: SessionsToolContext,
): { tool: Tool; handler: ToolHandler } {
  return {
    tool: {
      name: "sessions_spawn",
      description:
        "Create a new ACP session for async communication with another agent. " +
        "The target agent must be in the allowed agents list.",
      parameters: {
        type: "object",
        properties: {
          target_agent_id: {
            type: "string",
            description: "Agent ID to create session for (must be in allowedAgents)",
          },
          thread_id: {
            type: "string",
            description: "Optional Discord thread ID to bind the session to",
          },
          metadata: {
            type: "object",
            description: "Optional key-value metadata for the session",
          },
        },
        required: ["target_agent_id"],
      },
    },
    handler: async (args) => {
      const { target_agent_id, thread_id } = args as {
        target_agent_id: string;
        thread_id?: string;
        metadata?: Record<string, unknown>;
      };

      // Cannot spawn session for self
      if (target_agent_id === ctx.currentAgentId) {
        return JSON.stringify({
          error: "Cannot spawn a session for yourself. Use your existing session.",
        });
      }

      try {
        const session = ctx.sessionManager.createSession(target_agent_id, thread_id);

        log.info("Session spawned", {
          sessionId: session.id,
          targetAgent: target_agent_id,
          callingAgent: ctx.currentAgentId,
          threadId: thread_id,
        });

        return JSON.stringify({
          session_id: session.id,
          agent_id: session.agentId,
          status: session.status,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("Session spawn failed", { targetAgent: target_agent_id, error: message });
        return JSON.stringify({ error: message });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// sessions_announce
// ---------------------------------------------------------------------------

/**
 * Create the `sessions_announce` tool.
 *
 * Wraps AgentMessageBus.send() / broadcast() — lets an agent send messages
 * to other agents or broadcast to all.
 */
export function createSessionsAnnounceTool(
  ctx: SessionsToolContext,
): { tool: Tool; handler: ToolHandler } {
  return {
    tool: {
      name: "sessions_announce",
      description:
        "Broadcast a message to all agents or send to a specific agent/session. " +
        "Omit to_agent_id to broadcast to all agents.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Message content to broadcast or send",
          },
          to_agent_id: {
            type: "string",
            description: "Target agent ID (omit to broadcast to all)",
          },
          to_session_id: {
            type: "string",
            description: "Target session ID (requires to_agent_id)",
          },
          metadata: {
            type: "object",
            description: "Optional structured metadata",
          },
        },
        required: ["content"],
      },
    },
    handler: async (args) => {
      const { content, to_agent_id, to_session_id, metadata } = args as {
        content: string;
        to_agent_id?: string;
        to_session_id?: string;
        metadata?: Record<string, unknown>;
      };

      // Validate: content must be non-empty
      if (!content || content.trim().length === 0) {
        return JSON.stringify({ error: "Message content must not be empty" });
      }

      // Validate: to_session_id requires to_agent_id
      if (to_session_id && !to_agent_id) {
        return JSON.stringify({
          error: "to_session_id requires to_agent_id to be set",
        });
      }

      try {
        // Targeted send to a specific agent (optionally a specific session)
        if (to_agent_id) {
          const delivery = ctx.messageBus.send({
            fromAgentId: ctx.currentAgentId,
            fromSessionId: ctx.currentSessionId,
            toAgentId: to_agent_id,
            toSessionId: to_session_id,
            content,
            metadata,
          });

          log.info("Message sent", {
            messageId: delivery.messageId,
            from: ctx.currentAgentId,
            to: to_agent_id,
            sessionId: to_session_id,
            delivered: delivery.delivered,
          });

          return JSON.stringify({
            message_id: delivery.messageId,
            delivered: delivery.delivered,
            recipients: delivery.delivered ? 1 : 0,
          });
        }

        // Broadcast to all agents
        const deliveries = ctx.messageBus.broadcast(
          ctx.currentAgentId,
          content,
          metadata,
        );

        const deliveredCount = deliveries.filter((d) => d.delivered).length;

        log.info("Message broadcast", {
          from: ctx.currentAgentId,
          total: deliveries.length,
          delivered: deliveredCount,
        });

        return JSON.stringify({
          message_id: deliveries[0]?.messageId ?? "broadcast",
          delivered: deliveredCount > 0,
          recipients: deliveredCount,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("Announce failed", { from: ctx.currentAgentId, error: message });
        return JSON.stringify({ error: message });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// sessions_send
// ---------------------------------------------------------------------------

/** Default timeout for expect_reply in milliseconds. */
const REPLY_TIMEOUT_MS = 30_000;

/**
 * Create the `sessions_send` tool.
 *
 * Sends a directed message to a specific agent or session via
 * AgentMessageBus.send(). Optionally waits for a correlated reply
 * (convention-based: matching correlation_id in metadata).
 */
export function createSessionsSendTool(
  ctx: SessionsToolContext,
): { tool: Tool; handler: ToolHandler } {
  return {
    tool: {
      name: "sessions_send",
      description:
        "Send a message to a specific agent or session. " +
        "Set expect_reply=true to block until the recipient replies (30s timeout).",
      parameters: {
        type: "object",
        properties: {
          to_agent_id: {
            type: "string",
            description: "Target agent ID (required)",
          },
          to_session_id: {
            type: "string",
            description: "Target session ID (optional — if omitted, routes to agent's default handler)",
          },
          content: {
            type: "string",
            description: "Message content",
          },
          metadata: {
            type: "object",
            description: "Optional structured metadata (e.g., reply_to, priority)",
          },
          expect_reply: {
            type: "boolean",
            description: "If true, block until recipient replies (timeout 30s). Default: false",
          },
        },
        required: ["to_agent_id", "content"],
      },
    },
    handler: async (args) => {
      const { to_agent_id, to_session_id, content, metadata, expect_reply } = args as {
        to_agent_id: string;
        to_session_id?: string;
        content: string;
        metadata?: Record<string, unknown>;
        expect_reply?: boolean;
      };

      // Validate: content must be non-empty
      if (!content || content.trim().length === 0) {
        return JSON.stringify({ error: "Message content must not be empty" });
      }

      // Deadlock prevention: self-send with expect_reply
      if (expect_reply && to_agent_id === ctx.currentAgentId) {
        return JSON.stringify({
          error: "Cannot expect_reply when sending to yourself (deadlock prevention)",
        });
      }

      try {
        // When expect_reply is requested, set up the reply listener BEFORE
        // sending so we catch synchronous reply chains.
        let replyPromise: Promise<ReplyData | undefined> | undefined;
        let setCorrelationId: ((id: string) => void) | undefined;

        if (expect_reply) {
          const setup = prepareReplyListener(ctx, REPLY_TIMEOUT_MS);
          replyPromise = setup.promise;
          setCorrelationId = setup.setCorrelationId;
        }

        const delivery = ctx.messageBus.send({
          fromAgentId: ctx.currentAgentId,
          fromSessionId: ctx.currentSessionId,
          toAgentId: to_agent_id,
          toSessionId: to_session_id,
          content,
          metadata,
        });

        log.info("Message sent (sessions_send)", {
          messageId: delivery.messageId,
          from: ctx.currentAgentId,
          to: to_agent_id,
          sessionId: to_session_id,
          delivered: delivery.delivered,
          expectReply: !!expect_reply,
        });

        if (!expect_reply) {
          return JSON.stringify({
            message_id: delivery.messageId,
            delivered: delivery.delivered,
          });
        }

        // Now that we have the message ID, tell the listener what to correlate on
        setCorrelationId!(delivery.messageId);

        const reply = await replyPromise!;

        return JSON.stringify({
          message_id: delivery.messageId,
          delivered: delivery.delivered,
          reply: reply?.content ?? null,
          reply_metadata: reply?.metadata ?? null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("sessions_send failed", { from: ctx.currentAgentId, error: message });
        return JSON.stringify({ error: message });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Reply correlation helper
// ---------------------------------------------------------------------------

interface ReplyData {
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * Set up a reply listener BEFORE sending the message. This avoids TDZ issues
 * when the recipient handler replies synchronously during `messageBus.send()`.
 *
 * Returns a promise that resolves with the reply data (or undefined on
 * timeout), plus a callback to set the correlation ID once it's known
 * (i.e., after the send returns the message ID).
 */
function prepareReplyListener(
  ctx: SessionsToolContext,
  timeoutMs: number,
): { promise: Promise<ReplyData | undefined>; setCorrelationId: (id: string) => void } {
  let correlationId: string | undefined;
  let buffered: AgentMessage[] = [];
  let resolvePromise: (value: ReplyData | undefined) => void;
  let settled = false;

  const promise = new Promise<ReplyData | undefined>((resolve) => {
    resolvePromise = resolve;
  });

  // Subscribe to incoming messages for the calling agent.
  // Messages arriving before correlationId is set are buffered.
  const unsubscribe = ctx.messageBus.subscribe(ctx.currentAgentId, (msg) => {
    if (settled) return;
    if (correlationId === undefined) {
      buffered.push(msg);
      return;
    }
    if (msg.metadata?.correlation_id === correlationId) {
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      resolvePromise({ content: msg.content, metadata: msg.metadata });
    }
  });

  let timer: ReturnType<typeof setTimeout>;

  const setCorrelationId = (id: string) => {
    correlationId = id;

    // Check buffered messages for a match (handles synchronous replies)
    for (const msg of buffered) {
      if (settled) break;
      if (msg.metadata?.correlation_id === id) {
        settled = true;
        unsubscribe();
        resolvePromise({ content: msg.content, metadata: msg.metadata });
        break;
      }
    }
    buffered = [];

    if (settled) return;

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolvePromise(undefined);
    }, timeoutMs);
  };

  return { promise, setCorrelationId };
}

// ---------------------------------------------------------------------------
// sessions_list
// ---------------------------------------------------------------------------

/**
 * Create the `sessions_list` tool.
 *
 * Queries AcpSessionManager.listSessions() with optional filtering by
 * agent_id and status. Access control: can only filter by agents in the
 * allowedAgents configuration.
 */
export function createSessionsListTool(
  ctx: SessionsToolContext,
): { tool: Tool; handler: ToolHandler } {
  return {
    tool: {
      name: "sessions_list",
      description:
        "List ACP sessions, optionally filtered by agent or status. " +
        "Returns session metadata including ID, agent, status, and timestamps.",
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: "Filter by agent ID (must be in allowedAgents)",
          },
          status: {
            type: "string",
            enum: ["active", "idle", "terminated"],
            description: "Filter by session status",
          },
          limit: {
            type: "number",
            description: "Max sessions to return (default 20, max 100)",
          },
        },
      },
    },
    handler: async (args) => {
      const { agent_id, status, limit: rawLimit } = args as {
        agent_id?: string;
        status?: string;
        limit?: number;
      };

      // Access control: if filtering by agent_id, it must be in allowedAgents
      const allowedAgents = ctx.sessionManager.getConfig().allowedAgents ?? [];
      if (agent_id && allowedAgents.length > 0 && !allowedAgents.includes(agent_id)) {
        return JSON.stringify({
          error: `Cannot query sessions for agent: ${agent_id}`,
        });
      }

      try {
        const filter: { agentId?: string; status?: "active" | "idle" | "terminated" } = {};
        if (agent_id) filter.agentId = agent_id;
        if (status) filter.status = status as "active" | "idle" | "terminated";

        const allSessions = ctx.sessionManager.listSessions(
          Object.keys(filter).length > 0 ? filter : undefined,
        );

        const limit = Math.min(Math.max(rawLimit ?? 20, 1), 100);
        const total = allSessions.length;
        const sessions = allSessions.slice(0, limit);

        log.info("Sessions listed", {
          callingAgent: ctx.currentAgentId,
          filterAgent: agent_id,
          filterStatus: status,
          total,
          returned: sessions.length,
        });

        return JSON.stringify({
          sessions: sessions.map((s) => ({
            session_id: s.id,
            agent_id: s.agentId,
            status: s.status,
            created_at: s.createdAt.toISOString(),
            last_activity: s.lastActivityAt.toISOString(),
          })),
          total,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("sessions_list failed", { error: message });
        return JSON.stringify({ error: message });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// sessions_history
// ---------------------------------------------------------------------------

/**
 * Create the `sessions_history` tool.
 *
 * Reads message history from a specific ACP session. Access control: the
 * calling agent must own the session, OR the session's agent must be in
 * allowedAgents.
 */
export function createSessionsHistoryTool(
  ctx: SessionsToolContext,
): { tool: Tool; handler: ToolHandler } {
  return {
    tool: {
      name: "sessions_history",
      description:
        "Read message history from a specific ACP session. " +
        "Supports pagination via `before` cursor (ISO timestamp).",
      parameters: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "Session ID to read history from",
          },
          limit: {
            type: "number",
            description: "Max messages to return (default 50, max 200)",
          },
          before: {
            type: "string",
            description: "Pagination cursor — ISO timestamp; only messages before this time are returned",
          },
        },
        required: ["session_id"],
      },
    },
    handler: async (args) => {
      const { session_id, limit: rawLimit, before } = args as {
        session_id: string;
        limit?: number;
        before?: string;
      };

      const session = ctx.sessionManager.getSession(session_id);
      if (!session) {
        return JSON.stringify({ error: `Session not found: ${session_id}` });
      }

      // Access control: current agent owns the session OR the session agent is allowed
      const allowedAgents = ctx.sessionManager.getConfig().allowedAgents ?? [];
      const isOwner = session.agentId === ctx.currentAgentId;
      const agentAllowed = allowedAgents.includes(session.agentId);

      if (!isOwner && !agentAllowed) {
        return JSON.stringify({ error: `Access denied to session: ${session_id}` });
      }

      try {
        let messages = session.history;

        // Apply before cursor
        if (before) {
          const beforeTime = new Date(before).getTime();
          messages = messages.filter((m) => m.timestamp.getTime() < beforeTime);
        }

        const limit = Math.min(Math.max(rawLimit ?? 50, 1), 200);
        const hasMore = messages.length > limit;
        // Take the most recent `limit` messages
        messages = messages.slice(-limit);

        log.info("Session history read", {
          callingAgent: ctx.currentAgentId,
          sessionId: session_id,
          messageCount: messages.length,
          hasMore,
        });

        return JSON.stringify({
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp.toISOString(),
          })),
          has_more: hasMore,
          next_cursor: hasMore ? messages[0]?.timestamp.toISOString() : undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("sessions_history failed", { error: message });
        return JSON.stringify({ error: message });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create all session tools with shared context.
 * Returns an array of tool+handler pairs ready for registration.
 */
export function createSessionTools(
  ctx: SessionsToolContext,
): { tool: Tool; handler: ToolHandler }[] {
  return [
    createSessionsSpawnTool(ctx),
    createSessionsAnnounceTool(ctx),
    createSessionsSendTool(ctx),
    createSessionsListTool(ctx),
    createSessionsHistoryTool(ctx),
  ];
}
