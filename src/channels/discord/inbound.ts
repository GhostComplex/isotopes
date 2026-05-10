import type { Message as DiscordMessage } from "discord.js";
import type { DispatchCallbacks, Gateway, Message } from "../../gateway/index.js";
import { DedupeCache } from "./dedupe.js";
import { buildSessionKey } from "./session-key.js";
import { REPLY_DIRECTIVE_PROMPT } from "./reply-directive.js";
import { loggers } from "../../logging/logger.js";

const log = loggers.discord;

export interface GuildInboundConfig {
  requireMention?: boolean;
}

export interface InboundDeps {
  gateway: Gateway;
  /** botUserId → agentId. Falls back to defaultAgentId when no binding matches. */
  agentBindings?: Record<string, string>;
  defaultAgentId?: string;
  dedupe: DedupeCache;
  guilds?: Record<string, GuildInboundConfig>;
  /** Default true. */
  dedupeEnabled?: boolean;
  /** Default false. */
  allowBots?: boolean;
  /** Hook to prepend inbound metadata (sender, channel) before dispatch. */
  transformContent?: (content: string, msg: DiscordMessage, mentionKind: MentionKind) => string;
}

/** DispatchCallbacks + a post-dispatch cleanup hook (e.g. drain a buffer). */
export interface InboundCallbacks extends DispatchCallbacks {
  flushRemaining?(): Promise<void>;
}

export interface InboundContext {
  botId: string;
  buildCallbacks: (msg: DiscordMessage) => InboundCallbacks;
}

export type MentionKind = "precise" | "dm" | "reply_chain" | "quoted";

/**
 * Returns the implicit mention kind addressing this bot, or null.
 * Kinds: precise (`<@botId>`), dm, reply_chain, quoted (forwarded snapshot).
 */
export function detectMentionKind(msg: DiscordMessage, botId: string): MentionKind | null {
  if (msg.mentions?.has?.(botId)) return "precise";
  if (!msg.guild) return "dm";

  const referenced = (msg as unknown as { referencedMessage?: { author?: { id?: string } } })
    .referencedMessage;
  if (referenced?.author?.id === botId) return "reply_chain";

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


export function stripMentions(text: string): string {
  return text.replace(/<@!?\d+>/g, "").trim();
}

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
  if (msg.thread) return buildSessionKey("discord", botId, "thread", msg.thread.id);
  if (!msg.guild) return buildSessionKey("discord", botId, "dm", msg.author.id);
  return buildSessionKey("discord", botId, "channel", msg.channelId);
}

export async function handleInbound(
  msg: DiscordMessage,
  deps: InboundDeps,
  ctx: InboundContext,
): Promise<void> {
  if (msg.author.id === ctx.botId) return;
  if (msg.author.bot && !deps.allowBots) {
    log.debug(`discord receive: drop bot message from ${msg.author.username}`);
    return;
  }

  if (deps.dedupeEnabled !== false) {
    const dedupeKey = `${ctx.botId}:${msg.channelId}:${msg.id}`;
    if (deps.dedupe.isDuplicate(dedupeKey)) {
      log.debug(`discord receive: dedupe drop ${msg.id}`);
      return;
    }
  }

  const kind = detectMentionKind(msg, ctx.botId);
  const isDM = !msg.guild;
  const isMentioned = kind !== null && kind !== "dm";
  const requireMention = msg.guild ? deps.guilds?.[msg.guild.id]?.requireMention ?? true : false;
  // Respond if: DM, OR mention not required, OR explicitly mentioned.
  if (!isDM && requireMention && !isMentioned) {
    log.debug(`discord receive: not addressed (id=${msg.id}, kind=${kind})`);
    return;
  }

  const agentId = resolveAgentId(msg, deps.agentBindings, deps.defaultAgentId ?? "default");
  const sessionKey = resolveSessionKey(msg, ctx.botId);
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

  const callbacks = ctx.buildCallbacks(msg);
  try {
    await deps.gateway.dispatch(message, callbacks);
  } finally {
    // Must run even on dispatch error: outbound holds per-dispatch resources
    // (typing interval, edit timers) that only release here.
    if (callbacks.flushRemaining) {
      try {
        await callbacks.flushRemaining();
      } catch (err) {
        log.warn(`flushRemaining failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
