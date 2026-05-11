import type { Message as DiscordMessage } from "discord.js";
import type { DiscordAccountConfig } from "./types.js";

/**
 * (bot, channelId) → unique agentId. Threads inherit their parent channel's
 * mapping. Falls back to account.defaultAgentId when no per-channel override applies.
 */
export function resolveAgentId(msg: DiscordMessage, account: DiscordAccountConfig): string {
  const channel = msg.channel as { isThread?: () => boolean; parentId?: string | null };
  const lookupChannelId = channel.isThread?.() && channel.parentId ? channel.parentId : msg.channelId;
  return account.perChannelAgent?.[lookupChannelId] ?? account.defaultAgentId;
}
