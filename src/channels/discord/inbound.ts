import type { Message as DiscordMessage } from "discord.js";
import type { DispatchCallbacks, Gateway, Message } from "../../gateway/index.js";
import { DedupeCache } from "./dedupe.js";
import { REPLY_PROMPT } from "../reply.js";
import { loggers } from "../../logging/logger.js";
import type { GuildInboundConfig } from "./types.js";

const log = loggers.discord;

interface InboundDeps {
  gateway: Gateway;
  dedupe: DedupeCache;
  guilds?: Record<string, GuildInboundConfig>;
  /** Default true. */
  dedupeEnabled?: boolean;
  /** Default false. */
  allowBots?: boolean;
  /** Hook to prepend inbound metadata (sender, channel) before dispatch. */
  transformContent?: (content: string, msg: DiscordMessage, engagement: Engagement) => string;
}

/** DispatchCallbacks + a post-dispatch cleanup hook (e.g. drain a buffer). */
interface InboundCallbacks extends DispatchCallbacks {
  flushRemaining?(): Promise<void>;
}

interface InboundContext {
  botId: string;
  buildCallbacks: (msg: DiscordMessage) => InboundCallbacks;
}

type Engagement = "dm" | "mention" | "reply";

/**
 * Returns how this message engages the bot, or null if it doesn't.
 * Kinds: dm, mention (`<@botId>`), reply (to a bot message).
 */
export function detectEngagement(msg: DiscordMessage, botId: string): Engagement | null {
  if (!msg.guild) return "dm";
  if (msg.mentions?.has?.(botId)) return "mention";

  const referenced = (msg as unknown as { referencedMessage?: { author?: { id?: string } } })
    .referencedMessage;
  if (referenced?.author?.id === botId) return "reply";

  return null;
}

export async function handleInbound(
  msg: DiscordMessage,
  routing: { agentId: string; sessionKey: string },
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

  const engagement = detectEngagement(msg, ctx.botId);
  const isDM = !msg.guild;
  const isEngaged = engagement !== null && engagement !== "dm";
  const requireMention = msg.guild ? deps.guilds?.[msg.guild.id]?.requireMention ?? true : false;
  // Respond if: DM, OR mention not required, OR explicitly engaged.
  if (!isDM && requireMention && !isEngaged) {
    log.debug(`discord receive: not engaged (id=${msg.id}, engagement=${engagement})`);
    return;
  }

  const cleanedText = msg.content.replace(/<@!?\d+>/g, "").trim();
  const content = deps.transformContent
    ? deps.transformContent(cleanedText, msg, engagement!)
    : cleanedText;
  const message: Message = {
    agentId: routing.agentId,
    sessionKey: routing.sessionKey,
    content,
    source: "channel",
    sender: msg.author.username,
    timestamp: msg.createdTimestamp,
    extraSystemPrompt: REPLY_PROMPT,
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
