import type { Message as DiscordMessage, SendableChannels } from "discord.js";
import type { Gateway, Message, SessionEventListener } from "../../gateway/index.js";
import { createLogger } from "../../logging/logger.js";
import { REPLY_PROMPT } from "../reply.js";
import type { DiscordAccountConfig, GuildConfig } from "./types.js";
import { isDmAllowed, resolveGroupPolicy } from "./config.js";
import { extractAttachmentImages } from "./attachment.js";

const log = createLogger("discord:inbound");

/** True if msg is in a Discord thread (uses channel.isThread, not msg.thread). */
function isThreadMessage(msg: DiscordMessage): boolean {
  return (msg.channel as { isThread?: () => boolean })?.isThread?.() === true;
}

function threadParentId(msg: DiscordMessage): string | undefined {
  const ch = msg.channel as { isThread?: () => boolean; parentId?: string };
  return ch?.isThread?.() ? ch.parentId : undefined;
}

/** Pre-receive policy gate. False = silently drop. */
export function passesAllowlist(msg: DiscordMessage, account: DiscordAccountConfig): boolean {
  if (!msg.guild) {
    const ok = isDmAllowed(account, msg.author.id);
    return ok;
  }
  const group = resolveGroupPolicy(account);
  if (group.policy === "disabled") {
    return false;
  }
  if (group.policy === "allowlist") {
    // Fail-closed: allowlist policy with no rules is a misconfiguration.
    if (group.guildAllowlist === undefined && group.channelAllowlist === undefined) {
      return false;
    }
    if (group.guildAllowlist !== undefined && !group.guildAllowlist.includes(msg.guild.id)) {
      return false;
    }
    if (group.channelAllowlist !== undefined) {
      const parentId = threadParentId(msg);
      const channelOk = group.channelAllowlist.includes(msg.channelId)
        || (parentId !== undefined && group.channelAllowlist.includes(parentId));
      if (!channelOk) {
        return false;
      }
    }
  }
  return true;
}

/** Returns true if the message was a /stop and this handler consumed it. */
export async function handleStopCommand(
  msg: DiscordMessage,
  botId: string,
  gateway: Gateway,
  agentId: string,
  sessionKey: string,
  /** threadId → sub-run sessionId. The bot that spawned the thread aborts
   * the child session when /stop arrives in that thread. */
  a2aThreads?: Map<string, string>,
): Promise<boolean> {
  // Accept "/stop" optionally preceded by a single discord mention like "<@123>".
  let text = msg.content.trim().toLowerCase();
  if (text.startsWith("<@")) {
    const close = text.indexOf(">");
    if (close > 0) text = text.slice(close + 1).trim();
  }
  if (text !== "/stop") return false;

  // Consume /stop in every bot's handler so the command never leaks into
  // any LLM session or channel-history buffer. Only the addressed bot
  // (or the DM peer) actually aborts and confirms.
  const isAddressed = !msg.guild || msg.mentions?.has?.(botId) === true;
  if (!isAddressed) return true;

  let didStop = false;

  // A2A path: this bot spawned a child whose thread is msg.channel.
  const a2aSessionId = a2aThreads?.get(msg.channelId);
  if (a2aSessionId) {
    try {
      await gateway.abort(a2aSessionId, "user");
      didStop = true;
    } catch (err) {
      log.warn("/stop a2a abort failed", { a2aSessionId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  try {
    if (await gateway.abortByKey(agentId, sessionKey, "user")) {
      didStop = true;
    }
  } catch (err) {
    log.warn("/stop abort failed", { agentId, sessionKey, error: err instanceof Error ? err.message : String(err) });
  }

  if ("send" in msg.channel) {
    try {
      await (msg.channel as SendableChannels).send(didStop ? "🛑 Stopped." : "(nothing to stop)");
    } catch {
      /* ignore */
    }
  }
  log.info("/stop processed", { sessionKey, didStop });
  return true;
}

interface InboundDeps {
  gateway: Gateway;
  guilds?: Record<string, GuildConfig>;
  /** Default true. Set false to drop messages authored by other bots. */
  allowBots?: boolean;
  /** Hook to prepend inbound metadata (sender, channel) before dispatch. */
  transformContent?: (content: string, msg: DiscordMessage) => string;
}

/** Subscriber for one inbound message — receives session events until agent_end. */
export interface InboundSubscriber {
  onEvent: SessionEventListener;
  /** Resolves after agent_end is seen and any final flush completes. */
  done: Promise<void>;
}

interface InboundContext {
  botId: string;
  buildSubscriber: (msg: DiscordMessage) => InboundSubscriber;
}

export async function handleInbound(
  msg: DiscordMessage,
  routing: { agentId: string; sessionKey: string },
  deps: InboundDeps,
  ctx: InboundContext,
): Promise<void> {
  log.info("Message received", { author: msg.author.username, channelId: msg.channelId, guildId: msg.guild?.id });

  if (msg.author.id === ctx.botId) {
    log.debug("Filtered: own message", { authorId: msg.author.id });
    return;
  }
  if (msg.author.bot && deps.allowBots === false) {
    log.debug("Filtered: bot message", { author: msg.author.username });
    return;
  }

  if (msg.guild && isThreadMessage(msg) && deps.guilds?.[msg.guild.id]?.respondInThreads === false) {
    log.debug("Filtered: thread message", { channelId: msg.channelId });
    return;
  }

  if (msg.guild) {
    const requireMention = deps.guilds?.[msg.guild.id]?.requireMention ?? true;
    if (requireMention && !msg.mentions?.has?.(ctx.botId)) {
      log.debug("Filtered: not mentioned", { msgId: msg.id });
      return;
    }
  }

  const cleanedText = msg.content.replace(/<@!?\d+>/g, "").trim();
  const images = await extractAttachmentImages(msg);
  if (!cleanedText && images.length === 0) {
    log.debug("Filtered: empty message", { msgId: msg.id });
    return;
  }
  const content = deps.transformContent
    ? deps.transformContent(cleanedText, msg)
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

  await deps.gateway.createOrResumeSession(routing.agentId, routing.sessionKey);

  const subscriber = ctx.buildSubscriber(msg);
  const unsubscribe = await deps.gateway.subscribe(
    routing.agentId,
    routing.sessionKey,
    subscriber.onEvent,
  );
  if (!unsubscribe) {
    log.warn("Subscribe failed", { agentId: routing.agentId, sessionKey: routing.sessionKey });
    return;
  }

  try {
    const result = await deps.gateway.dispatch(message);
    if (result.state === "steered") {
      return;
    }
    await subscriber.done;
  } finally {
    unsubscribe();
  }
}
