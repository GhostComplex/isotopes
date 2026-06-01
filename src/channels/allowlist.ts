import type { ChannelTarget } from "./types.js";

/**
 * Shared allowlist match logic for cron delivery + the `message` tool.
 *
 * Entries are strings in one of two forms:
 *   - "type:channelId"  e.g. "discord:123"
 *   - "channelId"       matches any type (back-compat / brevity)
 */
export function matchesAllowedChannel(target: ChannelTarget, allow: readonly string[]): boolean {
  for (const raw of allow) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.includes(":")) {
      const [type, id] = entry.split(":", 2);
      if (type === target.type && id === target.channelId) return true;
    } else if (entry === target.channelId) {
      return true;
    }
  }
  return false;
}
