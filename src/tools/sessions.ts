// src/tools/sessions.ts — ACP session tools for inter-agent communication
// Exposes AcpSessionManager and AgentMessageBus to agents as callable tools.

import { createLogger } from "../core/logger.js";
import type { Tool } from "../core/types.js";
import type { ToolHandler } from "../core/tools.js";
import type { AcpSessionManager } from "../acp/session-manager.js";
import type { AgentMessageBus } from "../acp/message-bus.js";

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
// Factory
// ---------------------------------------------------------------------------

/**
 * Create both session tools with shared context.
 * Returns an array of tool+handler pairs ready for registration.
 */
export function createSessionTools(
  ctx: SessionsToolContext,
): { tool: Tool; handler: ToolHandler }[] {
  return [
    createSessionsSpawnTool(ctx),
    createSessionsAnnounceTool(ctx),
  ];
}
