// src/tools/react.ts — message_react tool

import { createLogger } from "../core/logger.js";
import type { Tool, Transport } from "../core/types.js";
import type { ToolHandler } from "../core/tools.js";

const log = createLogger("tools:react");

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** Runtime context required by react tools. */
export interface ReactToolContext {
  getTransport: () => Transport | undefined;
}

/**
 * Lazy transport context — holds a mutable reference to a Transport that can
 * be set after tool registration.  This allows cli.ts to register react tools
 * eagerly and bind the real transport once the channel transport starts.
 */
export class LazyTransportContext implements ReactToolContext {
  private _transport: Transport | undefined;

  setTransport(transport: Transport): void {
    this._transport = transport;
  }

  getTransport(): Transport | undefined {
    return this._transport;
  }
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
  ctx: ReactToolContext,
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
 * Create the react tool(s) with shared context.
 * Returns an array of tool+handler pairs ready for registration.
 */
export function createReactTools(
  ctx: ReactToolContext,
): { tool: Tool; handler: ToolHandler }[] {
  return [createMessageReactTool(ctx)];
}
