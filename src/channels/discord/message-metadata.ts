import type { Message as DiscordMessage } from "discord.js";

/** Structured metadata extracted from an incoming channel message. */
export interface MessageMetadata {
  /** The message's own ID (snowflake) */
  messageId: string;

  /** Sender information */
  sender: {
    id: string;
    username: string;
    displayName?: string;
    avatar?: string;
    isBot: boolean;
  };

  /** Timestamps (epoch milliseconds) */
  timestamps: {
    sent: number;
    received: number;
  };

  /** Channel the message was sent in */
  channel: {
    id: string;
    name?: string;
  };

  /** Message ID this is replying to, if any */
  replyTo?: string;
}

/**
 * Extract structured metadata from a Discord.js message.
 */
export function extractDiscordMetadata(msg: DiscordMessage): MessageMetadata {
  return {
    messageId: msg.id,
    sender: {
      id: msg.author.id,
      username: msg.author.username,
      displayName: msg.member?.displayName ?? msg.author.displayName ?? undefined,
      avatar: (typeof msg.author.avatarURL === "function" ? msg.author.avatarURL() : undefined) ?? undefined,
      isBot: msg.author.bot,
    },
    timestamps: {
      sent: msg.createdTimestamp,
      received: Date.now(),
    },
    channel: {
      id: msg.channelId,
      name: "name" in msg.channel ? (msg.channel.name ?? undefined) : undefined,
    },
    replyTo: msg.reference?.messageId ?? undefined,
  };
}

/** Render metadata as a compact bracket envelope for prompt injection. */
export function formatInboundMeta(meta: MessageMetadata, chatType: "direct" | "group"): string {
  const parts: string[] = ["Discord", "untrusted", chatType];

  const chanName = meta.channel.name ? `${escapeField(meta.channel.name)}/` : "";
  parts.push(`ch=${chanName}${meta.channel.id}`);

  const s = meta.sender;
  const sameName = !s.displayName || s.displayName === s.username;
  const senderLabel = sameName
    ? `${escapeField(s.username)}/${s.id}`
    : `${escapeField(s.displayName!)}/${escapeField(s.username)}/${s.id}`;
  parts.push(`from=${senderLabel}`);

  if (meta.replyTo) parts.push(`reply=${meta.replyTo}`);

  parts.push(`ts=${new Date(meta.timestamps.sent).toISOString()}`);
  parts.push(`msg=${meta.messageId}`);

  return `[${parts.join(" ")}]`;
}

/** Sanitize a header field — neutralize brackets, collapse whitespace. */
function escapeField(str: string): string {
  return str
    .replace(/\r\n|\r|\n|\t/g, " ")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}
