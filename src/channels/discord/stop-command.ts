import type { Message as DiscordMessage, SendableChannels } from "discord.js";
import { loggers } from "../../logging/logger.js";
import type { Gateway } from "../../gateway/index.js";

const log = loggers.discord;

const STOP_CMD_RE = /^(?:<@!?\S+>\s*)?\/(stop|cancel)\s*$/i;

/** Returns true if the message was a /stop directed at this bot (consumed). */
export async function maybeHandleStop(
  msg: DiscordMessage,
  botId: string,
  gateway: Gateway,
  agentId: string,
  sessionKey: string,
): Promise<boolean> {
  if (!STOP_CMD_RE.test(msg.content.trim())) return false;
  // In guild channels we still require the @mention so a shared /stop in a
  // multi-bot channel only aborts the addressed bot's session. DMs are 1:1.
  if (msg.guild && !msg.mentions?.has?.(botId)) return true; // not for us, but consume
  let cancelled = false;
  try {
    cancelled = await gateway.abortByKey(agentId, sessionKey, "user");
    log.info(`discord: /stop ${cancelled ? "aborted" : "no active run"} for sessionKey=${sessionKey}`);
  } catch (err) {
    log.warn(`discord: /stop abort failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if ("send" in msg.channel) {
    try {
      await (msg.channel as SendableChannels).send(cancelled ? "🛑 Stopped." : "(nothing to stop)");
    } catch {
      /* ignore */
    }
  }
  return true;
}
