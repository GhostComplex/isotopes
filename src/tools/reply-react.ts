// src/tools/reply-react.ts — message_reply and message_react tools

import { createLogger } from "../core/logger.js";
import type { Tool, Transport } from "../core/types.js";
import type { ToolHandler } from "../core/tools.js";

const log = createLogger("tools:reply-react");

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** Runtime context required by reply/react tools. */
export interface ReplyReactToolContext {
  getTransport: () => Transport | undefined;
}

/**
 * Lazy transport context — holds a mutable reference to a Transport that can
 * be set after tool registration.  This allows cli.ts to register reply/react
 * tools eagerly and bind the real transport once Discord starts.
 */
export class LazyTransportContext implements ReplyReactToolContext {
  private _transport: Transport | undefined;

  setTransport(transport: Transport): void {
    this._transport = transport;
  }

  getTransport(): Transport | undefined {
    return this._transport;
  }
}

// ---------------------------------------------------------------------------
// message_reply
// ---------------------------------------------------------------------------

/**
 * Create the `message_reply` tool.
 *
 * Replies to a specific message by its ID via the current transport.
 */
export function createMessageReplyTool(
  ctx: ReplyReactToolContext,
): { tool: Tool; handler: ToolHandler } {
  return {
    tool: {
      name: "message_reply",
      description:
        "Reply to a specific message by its ID. The reply is threaded / linked " +
        "to the original message in the transport (e.g. Discord reply). " +
        "Pass channel_id when known to avoid an expensive channel scan.",
      parameters: {
        type: "object",
        properties: {
          message_id: {
            type: "string",
            description: "ID of the message to reply to",
          },
          channel_id: {
            type: "string",
            description:
              "ID of the channel containing the message. " +
              "Optional but recommended — avoids O(n) channel scan.",
          },
          content: {
            type: "string",
            description: "Reply text content",
          },
        },
        required: ["message_id", "content"],
      },
    },
    handler: async (args) => {
      const { message_id, channel_id, content } = args as {
        message_id: string;
        channel_id?: string;
        content: string;
      };

      if (!message_id || !message_id.trim()) {
        return JSON.stringify({ error: "message_id must not be empty" });
      }
      if (!content || !content.trim()) {
        return JSON.stringify({ error: "content must not be empty" });
      }

      const transport = ctx.getTransport();
      if (!transport) {
        return JSON.stringify({ error: "Transport not available" });
      }
      if (!transport.reply) {
        return JSON.stringify({ error: "Transport does not support replies" });
      }

      try {
        const result = await transport.reply(message_id, content, channel_id);

        log.info("Message reply sent", {
          targetMessageId: message_id,
          replyMessageId: result.messageId,
        });

        return JSON.stringify({
          success: true,
          reply_message_id: result.messageId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("Message reply failed", { messageId: message_id, error: message });
        return JSON.stringify({ error: message });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// message_react
// ---------------------------------------------------------------------------

/**
 * Create the `message_react` tool.
 *
 * Adds an emoji reaction to a specific message by its ID via the current transport.
 */
export function createMessageReactTool(
  ctx: ReplyReactToolContext,
): { tool: Tool; handler: ToolHandler } {
  return {
    tool: {
      name: "message_react",
      description:
        "Add an emoji reaction to a specific message by its ID. " +
        "Use standard Unicode emoji (e.g. \"\u{1F44D}\") or platform-specific emoji identifiers. " +
        "Pass channel_id when known to avoid an expensive channel scan.",
      parameters: {
        type: "object",
        properties: {
          message_id: {
            type: "string",
            description: "ID of the message to react to",
          },
          channel_id: {
            type: "string",
            description:
              "ID of the channel containing the message. " +
              "Optional but recommended — avoids O(n) channel scan.",
          },
          emoji: {
            type: "string",
            description: "Emoji to react with (Unicode emoji or custom emoji identifier)",
          },
        },
        required: ["message_id", "emoji"],
      },
    },
    handler: async (args) => {
      const { message_id, channel_id, emoji } = args as {
        message_id: string;
        channel_id?: string;
        emoji: string;
      };

      if (!message_id || !message_id.trim()) {
        return JSON.stringify({ error: "message_id must not be empty" });
      }
      if (!emoji || !emoji.trim()) {
        return JSON.stringify({ error: "emoji must not be empty" });
      }

      const transport = ctx.getTransport();
      if (!transport) {
        return JSON.stringify({ error: "Transport not available" });
      }
      if (!transport.react) {
        return JSON.stringify({ error: "Transport does not support reactions" });
      }

      try {
        await transport.react(message_id, emoji, channel_id);

        log.info("Reaction added", {
          messageId: message_id,
          emoji,
        });

        return JSON.stringify({ success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("Reaction failed", { messageId: message_id, emoji, error: message });
        return JSON.stringify({ error: message });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create both reply and react tools with shared context.
 * Returns an array of tool+handler pairs ready for registration.
 */
export function createReplyReactTools(
  ctx: ReplyReactToolContext,
): { tool: Tool; handler: ToolHandler }[] {
  return [
    createMessageReplyTool(ctx),
    createMessageReactTool(ctx),
  ];
}
