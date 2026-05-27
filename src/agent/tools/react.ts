import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type { ChannelContext } from "../../channels/types.js";

function jsonResult(value: unknown): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: undefined };
}

const messageReactSchema = Type.Object({
  message_id: Type.String({ description: "ID of the message to react to" }),
  channel_id: Type.String({ description: "ID of the channel containing the message" }),
  emoji: Type.String({ description: "Emoji to react with (Unicode emoji or custom emoji identifier)" }),
});

export function createMessageReactTool(ctx: ChannelContext): AgentTool<typeof messageReactSchema> {
  return {
    name: "message_react",
    label: "message_react",
    description:
      "Add an emoji reaction to a specific message by its ID. " +
      "Use standard Unicode emoji (e.g. \"\u{1F44D}\") or platform-specific emoji identifiers. " +
      "channel_id is required — pass the ID of the channel containing the message.",
    parameters: messageReactSchema,
    execute: async (_id, { message_id, channel_id, emoji }) => {
      if (!message_id || !message_id.trim()) return jsonResult({ error: "message_id must not be empty" });
      if (!channel_id || !channel_id.trim()) return jsonResult({ error: "channel_id must not be empty" });
      if (!emoji || !emoji.trim()) return jsonResult({ error: "emoji must not be empty" });
      const actions = ctx.getChannelActions();
      if (!actions) return jsonResult({ error: "Channel not available" });
      if (!actions.react) return jsonResult({ error: "Channel does not support reactions" });
      try {
        await actions.react(message_id, emoji, channel_id);
        return jsonResult({ success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: message });
      }
    },
  };
}

export function createReactTools(ctx: ChannelContext): AgentTool[] {
  return [createMessageReactTool(ctx)];
}
