import type { Message as DiscordMessage } from "discord.js";
import { loggers } from "../../logging/logger.js";
import type { DiscordAccountConfig } from "./types.js";
import { isDmAllowed, resolveGroupPolicy } from "./config.js";

const log = loggers.discord;

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
    const channelOk = group.channelAllowlist?.includes(msg.channelId) ?? false;
    const guildOk = group.guildAllowlist?.includes(msg.guild.id) ?? false;
    if (!channelOk && !guildOk) {
      log.debug(
        `discord: drop guild message ${msg.id} (not in groupAccess allowlist, ` +
          `guild=${msg.guild.id} channel=${msg.channelId})`,
      );
      return false;
    }
  }
  return true;
}
