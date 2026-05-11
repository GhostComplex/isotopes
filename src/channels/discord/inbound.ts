import type { Message as DiscordMessage, SendableChannels } from "discord.js";
import type { DispatchCallbacks, Gateway, Message } from "../../gateway/index.js";
import { DedupeCache } from "./dedupe.js";
import { REPLY_PROMPT } from "../reply.js";
import { loggers } from "../../logging/logger.js";
import type { DiscordAccountConfig, GuildInboundConfig } from "./types.js";
import { isDmAllowed, resolveGroupPolicy } from "./config.js";
import { extractAttachmentImages, hasImageAttachments } from "./attachment.js";

const log = loggers.discord;

/** True if msg is in a Discord thread (uses channel.isThread, not msg.thread). */
function isThreadMessage(msg: DiscordMessage): boolean {
  return (msg.channel as { isThread?: () => boolean })?.isThread?.() === true;
}

/** Parent channel id when msg is in a thread, else undefined. */
function threadParentId(msg: DiscordMessage): string | undefined {
  const ch = msg.channel as { isThread?: () => boolean; parentId?: string };
  return ch?.isThread?.() ? ch.parentId : undefined;
}

/** Pre-receive policy gate. False = silently drop. */
export function passesAllowlist(msg: DiscordMessage, account: DiscordAccountConfig): boolean {
  if (!msg.guild) {
    const ok = isDmAllowed(account, msg.author.id);
    if (!ok) log.debug(`discord: drop dm from ${msg.author.id} (dmAccess policy)`);
    return ok;
  }
  const group = resolveGroupPolicy(account);
  if (group.policy === "disabled") {
    log.debug(`discord: drop guild message ${msg.id} (groupAccess.policy=disabled)`);
    return false;
  }
  if (group.policy === "allowlist") {
    // Fail-closed: allowlist policy with no rules is a misconfiguration.
    if (group.guildAllowlist === undefined && group.channelAllowlist === undefined) {
      log.debug(`discord: drop guild message ${msg.id} (allowlist policy with no rules)`);
      return false;
    }
    if (group.guildAllowlist !== undefined && !group.guildAllowlist.includes(msg.guild.id)) {
      log.debug(`discord: drop ${msg.id} (guild ${msg.guild.id} not in guildAllowlist)`);
      return false;
    }
    if (group.channelAllowlist !== undefined) {
      // For thread messages, also accept the thread's parent channel.
      const parentId = threadParentId(msg);
      const channelOk = group.channelAllowlist.includes(msg.channelId)
        || (parentId !== undefined && group.channelAllowlist.includes(parentId));
      if (!channelOk) {
        log.debug(`discord: drop ${msg.id} (channel ${msg.channelId} not in channelAllowlist)`);
        return false;
      }
    }
  }
  return true;
}

/** Returns true if the message was a /stop directed at this bot (consumed). */
export async function maybeHandleStop(
  msg: DiscordMessage,
  botId: string,
  gateway: Gateway,
  agentId: string,
  sessionKey: string,
): Promise<boolean> {
  // Accept "/stop" optionally preceded by a discord mention like "<@123>".
  let text = msg.content.trim().toLowerCase();
  if (text.startsWith("<@")) {
    const close = text.indexOf(">");
    if (close > 0) text = text.slice(close + 1).trim();
  }
  if (text !== "/stop") return false;
  // In guild channels we still require the @mention so a shared /stop in a
  // multi-bot channel only aborts the addressed bot's session. DMs are 1:1.
  if (msg.guild && !msg.mentions?.has?.(botId)) return true; // not for us, but consume
  let stopped = false;
  try {
    stopped = await gateway.abortByKey(agentId, sessionKey, "user");
    log.info(`discord: /stop ${stopped ? "aborted" : "no active run"} for sessionKey=${sessionKey}`);
  } catch (err) {
    log.warn(`discord: /stop abort failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if ("send" in msg.channel) {
    try {
      await (msg.channel as SendableChannels).send(stopped ? "🛑 Stopped." : "(nothing to stop)");
    } catch {
      /* ignore */
    }
  }
  return true;
}

interface InboundDeps {
  gateway: Gateway;
  dedupe: DedupeCache;
  guilds?: Record<string, GuildInboundConfig>;
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

  // Per-guild thread gate: drop thread messages when guild has respondInThreads=false.
  if (msg.guild && isThreadMessage(msg) && deps.guilds?.[msg.guild.id]?.respondInThreads === false) {
    log.debug(`discord receive: drop thread message ${msg.id} (respondInThreads=false)`);
    return;
  }

  const dedupeKey = `${ctx.botId}:${msg.channelId}:${msg.id}`;
  if (deps.dedupe.isDuplicate(dedupeKey)) {
    log.debug(`discord receive: dedupe drop ${msg.id}`);
    return;
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
  const images = hasImageAttachments(msg) ? await extractAttachmentImages(msg) : [];
  // Don't dispatch a wholly empty turn (no text + no images).
  if (!cleanedText && images.length === 0) return;
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
    ...(images.length > 0 ? { images } : {}),
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
