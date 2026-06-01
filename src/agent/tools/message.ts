import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type { ChannelContext } from "../../channels/types.js";

function jsonResult(value: unknown): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: undefined };
}

const messageSendSchema = Type.Object({
  channel_id: Type.String({ description: "ID of the channel to send the message to" }),
  content: Type.String({ description: "Message content to send" }),
});

export function createMessageSendTool(
  ctx: ChannelContext,
  allowedChannels?: string[],
): AgentTool<typeof messageSendSchema> {
  return {
    name: "message_send",
    label: "message_send",
    description:
      "Send a message to a specific channel by its ID. " +
      "Use this to post results, notifications, or updates to a channel.",
    parameters: messageSendSchema,
    execute: async (_id, { channel_id, content }) => {
      if (!channel_id || !channel_id.trim()) return jsonResult({ error: "channel_id must not be empty" });
      if (!content || !content.trim()) return jsonResult({ error: "content must not be empty" });
      if (allowedChannels && allowedChannels.length > 0 && !allowedChannels.includes(channel_id)) {
        return jsonResult({ error: `Channel ${channel_id} is not in the allowed channels list` });
      }
      const actions = ctx.getChannelActions();
      if (!actions) return jsonResult({ error: "Channel not available" });
      if (!actions.sendMessage) return jsonResult({ error: "Channel does not support sending messages" });
      try {
        const result = await actions.sendMessage(channel_id, content);
        return jsonResult({ success: true, messageId: result.id });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: message });
      }
    },
  };
}

export function createMessageTools(ctx: ChannelContext, allowedChannels?: string[]): AgentTool[] {
  return [createMessageSendTool(ctx, allowedChannels)];
}
