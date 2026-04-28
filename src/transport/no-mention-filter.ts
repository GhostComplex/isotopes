// src/transport/no-mention-filter.ts — Decide whether an agent should
// receive a channel message even when not @-mentioned ("manager bot" mode).
//
// Pure function; transports configure per (agent, channel) and call this on
// every inbound message after channel-membership has already been resolved.

export interface NoMentionConfig {
  enabled: boolean;
  ignoreSelf?: boolean;
  ignoreBots?: boolean;
}

export interface IncomingMessage {
  authorId: string;
  isBot?: boolean;
  mentions: string[];
}

export function shouldDeliver(
  agentId: string,
  message: IncomingMessage,
  config: NoMentionConfig,
): boolean {
  if (config.ignoreSelf && message.authorId === agentId) return false;
  if (!config.enabled) {
    return message.mentions.includes(agentId);
  }
  if (config.ignoreBots && message.isBot) return false;
  return true;
}
