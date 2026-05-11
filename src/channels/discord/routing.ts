import type { Message as DiscordMessage } from "discord.js";

export function resolveAgentId(
  msg: DiscordMessage,
  agentBindings: Record<string, string> | undefined,
  defaultAgentId: string,
): string {
  if (agentBindings) {
    for (const [botUserId, agentId] of Object.entries(agentBindings)) {
      if (msg.mentions?.has?.(botUserId)) return agentId;
    }
  }
  return defaultAgentId;
}

export function resolveSessionKey(msg: DiscordMessage, botId: string): string {
  if (msg.thread) return `discord:${botId}:thread:${msg.thread.id}`;
  if (!msg.guild) return `discord:${botId}:dm:${msg.author.id}`;
  return `discord:${botId}:channel:${msg.channelId}`;
}
