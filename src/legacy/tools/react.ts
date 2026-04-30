// src/tools/react.ts — message_react tool

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { createLogger } from "../../logging/logger.js";
import type { Transport } from "../../gateway/types.js";

const log = createLogger("tools:react");

function jsonResult(value: unknown): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: undefined };
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ReactToolContext {
  getTransport: () => Transport | undefined;
}

export class LazyTransportContext implements ReactToolContext {
  private _transport: Transport | undefined;
  setTransport(transport: Transport): void { this._transport = transport; }
  getTransport(): Transport | undefined { return this._transport; }
}

// ---------------------------------------------------------------------------
// message_react
// ---------------------------------------------------------------------------

const messageReactSchema = Type.Object({
  message_id: Type.String({ description: "ID of the message to react to" }),
  channel_id: Type.Optional(Type.String({
    description:
      "ID of the channel containing the message. " +
      "Optional but recommended — avoids O(n) channel scan.",
  })),
  emoji: Type.String({ description: "Emoji to react with (Unicode emoji or custom emoji identifier)" }),
});

export function createMessageReactTool(ctx: ReactToolContext): AgentTool<typeof messageReactSchema> {
  return {
    name: "message_react",
    label: "message_react",
    description:
      "Add an emoji reaction to a specific message by its ID. " +
      "Use standard Unicode emoji (e.g. \"\u{1F44D}\") or platform-specific emoji identifiers. " +
      "Pass channel_id when known to avoid an expensive channel scan.",
    parameters: messageReactSchema,
    execute: async (_id, { message_id, channel_id, emoji }) => {
      if (!message_id || !message_id.trim()) return jsonResult({ error: "message_id must not be empty" });
      if (!emoji || !emoji.trim()) return jsonResult({ error: "emoji must not be empty" });
      const transport = ctx.getTransport();
      if (!transport) return jsonResult({ error: "Transport not available" });
      if (!transport.react) return jsonResult({ error: "Transport does not support reactions" });
      try {
        await transport.react(message_id, emoji, channel_id);
        log.info("Reaction added", { messageId: message_id, emoji });
        return jsonResult({ success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("Reaction failed", { messageId: message_id, emoji, error: message });
        return jsonResult({ error: message });
      }
    },
  };
}

export function createReactTools(ctx: ReactToolContext): AgentTool[] {
  return [createMessageReactTool(ctx)];
}
