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

/** Render metadata as an XML block for prompt injection. */
export function formatInboundMeta(meta: MessageMetadata, chatType: "direct" | "group"): string {
  const lines: string[] = [
    `<inbound_meta type="untrusted">`,
    `  <message_id>${meta.messageId}</message_id>`,
    `  <chat_type>${chatType}</chat_type>`,
    `  <channel_id>${meta.channel.id}</channel_id>`,
  ];
  
  if (meta.channel.name) {
    lines.push(`  <channel_name>${escapeXml(meta.channel.name)}</channel_name>`);
  }
  
  lines.push(
    `  <sender_id>${meta.sender.id}</sender_id>`,
    `  <sender_username>${escapeXml(meta.sender.username)}</sender_username>`,
  );
  
  if (meta.sender.displayName) {
    lines.push(`  <sender_display_name>${escapeXml(meta.sender.displayName)}</sender_display_name>`);
  }
  
  lines.push(`  <timestamp>${meta.timestamps.sent}</timestamp>`);
  
  if (meta.replyTo) {
    lines.push(`  <reply_to>${meta.replyTo}</reply_to>`);
  }
  
  lines.push(`</inbound_meta>`);
  
  return lines.join("\n");
}

/** Escape XML special characters. */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
