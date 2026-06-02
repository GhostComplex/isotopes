import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "typebox";
import type { ChannelTarget } from "../../channels/types.js";
import type { ChannelRouter } from "../../channels/router.js";
import { matchesAllowedChannel } from "../../channels/allowlist.js";

function jsonResult(value: unknown): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: undefined };
}

const targetSchema = Type.Object({
  type: Type.Optional(Type.String({ description: "Channel kind (e.g. \"discord\"). Defaults to the only configured kind." })),
  accountId: Type.Optional(Type.String({ description: "Account id for multi-account setups." })),
  channelId: Type.String({ description: "Channel id (or thread parent id)." }),
  threadId: Type.Optional(Type.String({ description: "Thread id when posting in / reading from a thread." })),
});

const schema = Type.Object({
  action: Type.Union([Type.Literal("send"), Type.Literal("read")], {
    description: "send: post a message. read: fetch recent messages from a channel.",
  }),
  target: targetSchema,
  content: Type.Optional(Type.String({ description: "Required for action=send. Message text." })),
  limit: Type.Optional(Type.Number({ description: "action=read: number of recent messages to fetch (1-100, default 30)." })),
});

const DEFAULT_TYPE = "discord";
const DEFAULT_READ_LIMIT = 30;
const MAX_READ_LIMIT = 100;

export function createMessageTool(
  router: ChannelRouter,
  allowedChannels?: readonly string[],
): AgentTool<typeof schema> {
  return {
    name: "message",
    label: "message",
    description:
      "Post a message to a channel (action=\"send\") or read recent messages from a channel " +
      "(action=\"read\"). Use action=read to inspect channel history before deciding what to send.",
    parameters: schema,
    execute: async (_id, raw) => {
      const args = raw as Static<typeof schema>;
      const target: ChannelTarget = {
        type: args.target.type ?? DEFAULT_TYPE,
        channelId: args.target.channelId,
        ...(args.target.accountId ? { accountId: args.target.accountId } : {}),
        ...(args.target.threadId ? { threadId: args.target.threadId } : {}),
      };

      if (!target.channelId.trim()) return jsonResult({ error: "target.channelId must not be empty" });
      if (allowedChannels && allowedChannels.length > 0 && !matchesAllowedChannel(target, allowedChannels)) {
        return jsonResult({ error: `Channel ${target.type}:${target.channelId} is not in the allowed channels list` });
      }

      try {
        if (args.action === "send") {
          if (!args.content?.trim()) return jsonResult({ error: "content must not be empty for action=send" });
          const { id } = await router.send(target, args.content);
          return jsonResult({ ok: true, messageId: id });
        }
        // action === "read"
        const limit = Math.min(Math.max(args.limit ?? DEFAULT_READ_LIMIT, 1), MAX_READ_LIMIT);
        const messages = await router.fetchHistory(target, { limit });
        return jsonResult({ ok: true, messages });
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

export function createMessageTools(
  router: ChannelRouter,
  allowedChannels?: readonly string[],
): AgentTool[] {
  return [createMessageTool(router, allowedChannels)];
}
