import type { Message as DiscordMessage, SendableChannels } from "discord.js";
import type { Gateway, Message, SessionEventListener } from "../../gateway/index.js";
import { REPLY_PROMPT } from "../reply.js";
import { createLogger } from "../../logging/logger.js";
import type { DiscordAccountConfig, GuildConfig } from "./types.js";
import { isDmAllowed, resolveGroupPolicy } from "./config.js";
import { extractAttachmentImages } from "./attachment.js";

const log = createLogger("discord");

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

  // Sub-run path: this bot spawned a child whose thread is msg.channel.
  const subSessionId = a2aThreads?.get(msg.channelId);
  if (subSessionId) {
    try {
      await gateway.abort(subSessionId, "user");
      didStop = true;
      log.info(`discord: /stop sub-run aborted (sessionId=${subSessionId})`);
    } catch (err) {
      log.warn(`discord: /stop sub-run abort failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    if (await gateway.abortByKey(agentId, sessionKey, "user")) {
      didStop = true;
      log.info(`discord: /stop aborted sessionKey=${sessionKey}`);
    } else {
      log.info(`discord: /stop no active run for sessionKey=${sessionKey}`);
    }
  } catch (err) {
    log.warn(`discord: /stop abort failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if ("send" in msg.channel) {
    try {
      await (msg.channel as SendableChannels).send(didStop ? "🛑 Stopped." : "(nothing to stop)");
    } catch {
      /* ignore */
    }
  }
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
  if (msg.author.id === ctx.botId) return;
  if (msg.author.bot && deps.allowBots === false) {
    log.debug(`discord receive: drop bot message from ${msg.author.username}`);
    return;
  }

  if (msg.guild && isThreadMessage(msg) && deps.guilds?.[msg.guild.id]?.respondInThreads === false) {
    log.debug(`discord receive: drop thread message ${msg.id} (respondInThreads=false)`);
    return;
  }

  if (msg.guild) {
    const requireMention = deps.guilds?.[msg.guild.id]?.requireMention ?? true;
    if (requireMention && !msg.mentions?.has?.(ctx.botId)) {
      log.debug(`discord receive: not mentioned (id=${msg.id})`);
      return;
    }
  }

  const cleanedText = msg.content.replace(/<@!?\d+>/g, "").trim();
  const images = await extractAttachmentImages(msg);
  if (!cleanedText && images.length === 0) return; // empty turn
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
    log.warn(`discord receive: subscribe failed for ${routing.sessionKey}`);
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
