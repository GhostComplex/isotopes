// src/channels/discord/receive.ts — Discord inbound pipeline.
//
// Lifts the inbound concerns out of the legacy DiscordTransport.handleMessage:
//   1. dedupe (drop replays)
//   2. mention check (precise @, DM, reply-chain, quoted/forwarded)
//   3. resolve agentId via agentBindings
//   4. resolve sessionKey (channel | dm | thread)
//   5. build a Gateway Message
//   6. dispatch to the gateway with caller-supplied callbacks
//
// Outbound (text streaming, replies, reactions) is intentionally NOT here —
// see ./outbound.ts (subtask #781) and ./index.ts (subtask #782) for wiring.

import type { Message as DiscordMessage } from "discord.js";
import type { DispatchCallbacks, Gateway, Message } from "../../gateway/index.js";
import { DedupeCache } from "./dedupe.js";
import { shouldRespondToMessage } from "./mention.js";
import { buildSessionKey } from "./session-key.js";
import { REPLY_DIRECTIVE_PROMPT } from "./reply-directive.js";
import { loggers } from "../../logging/logger.js";

const log = loggers.discord;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-guild override knobs consumed by the inbound pipeline. */
export interface GuildReceiveConfig {
  requireMention?: boolean;
}

export interface ReceiveDeps {
  /** Gateway to dispatch the inbound Message to. */
  gateway: Gateway;
  /** botUserId → agentId. Empty/undefined means "fall back to defaultAgentId". */
  agentBindings?: Record<string, string>;
  /** Default agent when no binding matches. */
  defaultAgentId?: string;
  /** Shared dedupe cache (carry across calls; usually owned by the channel). */
  dedupe: DedupeCache;
  /** Per-guild config (currently just requireMention). */
  guilds?: Record<string, GuildReceiveConfig>;
  /** Whether to honor the dedupe cache. Default: true. */
  dedupeEnabled?: boolean;
  /** Whether to respond to messages from other bots. Default: false. */
  allowBots?: boolean;
  /**
   * Optional hook to transform the cleaned message content before dispatch.
   * Used by the channel adapter to prepend inbound metadata (sender, channel,
   * timestamp) so the agent has multi-user context.
   */
  transformContent?: (content: string, msg: DiscordMessage, mentionKind: MentionKind) => string;
}

export interface ReceiveContext {
  /** This bot's user id (i.e. client.user.id). Required for mention/dedupe/session keys. */
  botId: string;
  /** Build the per-message DispatchCallbacks (outbound concerns live in caller). */
  buildCallbacks: (msg: DiscordMessage) => DispatchCallbacks;
}

// ---------------------------------------------------------------------------
// Mention detection — preserves the 4 implicit kinds.
// ---------------------------------------------------------------------------

export type MentionKind = "precise" | "dm" | "reply_chain" | "quoted";

/**
 * Determine which mention kind (if any) addresses this bot.
 * Returns null when the message is not addressed to the bot.
 *
 * Kinds:
 *  - "precise"      — explicit `<@botId>` mention
 *  - "dm"           — direct message channel (no guild)
 *  - "reply_chain"  — user replied to a message previously authored by this bot
 *  - "quoted"       — forwarded message snapshot containing the bot's mention
 */
export function detectMentionKind(msg: DiscordMessage, botId: string): MentionKind | null {
  // 1. Precise @mention
  if (msg.mentions?.has?.(botId)) return "precise";

  // 2. DM
  if (!msg.guild) return "dm";

  // 3. Reply-chain: user replied to a message authored by this bot.
  // discord.js exposes `referencedMessage` lazily; fall back to `reference.messageId`
  // and let the caller resolve if needed. We only treat it as reply_chain when the
  // referenced author is known to be this bot.
  const referenced = (msg as unknown as { referencedMessage?: { author?: { id?: string } } })
    .referencedMessage;
  if (referenced?.author?.id === botId) return "reply_chain";

  // 4. Quoted/forwarded snapshot containing a mention of this bot.
  const snapshots = (msg as unknown as {
    messageSnapshots?: Map<string, { mentions?: { has?: (id: string) => boolean }; content?: string }>
      | Array<{ mentions?: { has?: (id: string) => boolean }; content?: string }>;
  }).messageSnapshots;
  if (snapshots) {
    const iter: Iterable<{ mentions?: { has?: (id: string) => boolean }; content?: string }> =
      snapshots instanceof Map ? snapshots.values() : snapshots;
    for (const snap of iter) {
      if (snap.mentions?.has?.(botId)) return "quoted";
      if (snap.content && snap.content.includes(`<@${botId}>`)) return "quoted";
      if (snap.content && snap.content.includes(`<@!${botId}>`)) return "quoted";
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip Discord-style numeric @mentions from text. */
export function stripMentions(text: string): string {
  return text.replace(/<@!?\d+>/g, "").trim();
}

/** Resolve agentId from bindings: first matching mention wins, then default. */
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

/** Build the session key for a Discord message (thread > dm > channel). */
export function resolveSessionKey(msg: DiscordMessage, botId: string): string {
  if (msg.thread) {
    return buildSessionKey("discord", botId, "thread", msg.thread.id);
  }
  if (!msg.guild) {
    return buildSessionKey("discord", botId, "dm", msg.author.id);
  }
  return buildSessionKey("discord", botId, "channel", msg.channelId);
}

// ---------------------------------------------------------------------------
// Pipeline entry
// ---------------------------------------------------------------------------

/**
 * Handle a Discord `messageCreate` event. Returns silently when the message
 * should be ignored (self, other bot, dedupe hit, not addressed).
 */
export async function receiveDiscordMessage(
  msg: DiscordMessage,
  deps: ReceiveDeps,
  ctx: ReceiveContext,
): Promise<void> {
  // 0. Drop self & (by default) other bots.
  if (msg.author.id === ctx.botId) return;
  if (msg.author.bot && !deps.allowBots) {
    log.debug(`discord receive: drop bot message from ${msg.author.username}`);
    return;
  }

  // 1. Dedupe.
  if (deps.dedupeEnabled !== false) {
    const dedupeKey = `${ctx.botId}:${msg.channelId}:${msg.id}`;
    if (deps.dedupe.isDuplicate(dedupeKey)) {
      log.debug(`discord receive: dedupe drop ${msg.id}`);
      return;
    }
  }

  // 2. Mention check. DMs always pass; in guilds we honor requireMention
  //    against the union of the 4 implicit mention kinds.
  const kind = detectMentionKind(msg, ctx.botId);
  const isDM = !msg.guild;
  const requireMention = msg.guild ? deps.guilds?.[msg.guild.id]?.requireMention ?? true : false;
  const addressed = shouldRespondToMessage({
    isMentioned: kind !== null && kind !== "dm",
    isDM,
    requireMention,
  });
  if (!addressed) {
    log.debug(`discord receive: not addressed (id=${msg.id}, kind=${kind})`);
    return;
  }

  // 3. Resolve agentId.
  const agentId = resolveAgentId(msg, deps.agentBindings, deps.defaultAgentId ?? "default");

  // 4. Session key.
  const sessionKey = resolveSessionKey(msg, ctx.botId);

  // 5. Build the gateway Message.
  const cleanedText = stripMentions(msg.content);
  const content = deps.transformContent
    ? deps.transformContent(cleanedText, msg, kind!)
    : cleanedText;
  const message: Message = {
    agentId,
    sessionKey,
    content,
    source: "channel",
    sender: msg.author.username,
    timestamp: msg.createdTimestamp,
    extraSystemPrompt: REPLY_DIRECTIVE_PROMPT,
  };

  // 6. Dispatch. Outbound callbacks are produced by the caller (outbound.ts).
  //    If the callbacks expose a `flushRemaining()` hook (the OutboundCallbacks
  //    contract from outbound.ts), invoke it after dispatch so any text still
  //    sitting in the segmented stream buffer is delivered.
  const callbacks = ctx.buildCallbacks(msg);
  await deps.gateway.dispatch(message, callbacks);
  const maybeFlush = (callbacks as { flushRemaining?: () => Promise<void> }).flushRemaining;
  if (typeof maybeFlush === "function") {
    try {
      await maybeFlush.call(callbacks);
    } catch (err) {
      log.warn(`flushRemaining failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
