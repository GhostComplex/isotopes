// src/core/mention.ts — Mention detection and requirement checking
// Determines whether a bot should respond to a message based on guild/group config.

import type { ChannelsConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context needed to evaluate whether a message should be handled */
export interface MentionContext {
  /** The bot's own user ID (e.g. Discord bot user ID) */
  botUserId: string;
  /** The guild/group ID where the message was sent (undefined for DMs) */
  guildId?: string;
  /** The account ID from the config (e.g. "major", "tachikoma") */
  accountId?: string;
  /** Whether the bot was @mentioned in the message */
  isMentioned: boolean;
  /** Whether this is a DM (no guild) */
  isDM: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a bot should respond to a message based on mention config.
 *
 * Rules:
 *   1. DMs: always respond (no mention required)
 *   2. Guild message + requireMention=false: always respond
 *   3. Guild message + requireMention=true (default): only respond if @mentioned
 */
export function shouldRespondToMessage(
  channels: ChannelsConfig | undefined,
  ctx: MentionContext,
): boolean {
  // DMs: always respond
  if (ctx.isDM) return true;

  // No guild context: fall back to mention check
  if (!ctx.guildId) return ctx.isMentioned;

  // Look up guild config
  const requireMention = resolveRequireMention(channels, ctx.accountId, ctx.guildId);

  if (!requireMention) {
    // requireMention=false → respond to all messages in this guild
    return true;
  }

  // requireMention=true (default) → only respond when @mentioned
  return ctx.isMentioned;
}

/**
 * Resolve whether @mention is required for a Discord guild.
 * Default: true
 */
export function resolveRequireMention(
  channels: ChannelsConfig | undefined,
  accountId: string | undefined,
  guildId: string,
): boolean {
  if (!channels?.discord?.accounts || !accountId) return true;

  const account = channels.discord.accounts[accountId];
  if (!account?.guilds) return true;

  const guildConfig = account.guilds[guildId];
  if (!guildConfig) return true;

  return guildConfig.requireMention ?? true;
}
