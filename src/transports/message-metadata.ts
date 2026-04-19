// src/transports/message-metadata.ts — Structured message metadata for transports

import type { Message as DiscordMessage } from "discord.js";

// ---------------------------------------------------------------------------
// Channel types
// ---------------------------------------------------------------------------

/** The kind of channel the message was sent in. */
export type ChannelType = "text" | "dm" | "thread" | "voice" | "news" | "unknown";

// ---------------------------------------------------------------------------
// MessageMetadata
// ---------------------------------------------------------------------------

/** Structured metadata extracted from an incoming transport message. */
export interface MessageMetadata {
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
    type: ChannelType;
  };

  /** Message ID this is replying to, if any */
  replyTo?: string;
}

// ---------------------------------------------------------------------------
// Discord extraction
// ---------------------------------------------------------------------------

/** Map discord.js channel types to our ChannelType enum. */
function resolveDiscordChannelType(channelType: number): ChannelType {
  // discord.js ChannelType enum values:
  // 0 = GuildText, 1 = DM, 2 = GuildVoice, 5 = GuildAnnouncement (news),
  // 10 = AnnouncementThread, 11 = PublicThread, 12 = PrivateThread
  switch (channelType) {
    case 0: return "text";
    case 1: return "dm";
    case 2: return "voice";
    case 5: return "news";
    case 10:
    case 11:
    case 12: return "thread";
    default: return "unknown";
  }
}

/**
 * Extract structured metadata from a Discord.js message.
 */
export function extractDiscordMetadata(msg: DiscordMessage): MessageMetadata {
  return {
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
      type: resolveDiscordChannelType(msg.channel.type),
    },
    replyTo: msg.reference?.messageId ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Inbound metadata formatting (untrusted context block)
// ---------------------------------------------------------------------------

/** Format metadata as an XML block for injection into message content. */
export function formatInboundMeta(meta: MessageMetadata, chatType: "direct" | "group"): string {
  const lines: string[] = [
    `<inbound_meta type="untrusted">`,
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
