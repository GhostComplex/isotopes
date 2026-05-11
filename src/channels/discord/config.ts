import type { DiscordAccountConfig, GuildConfig, GuildInboundConfig } from "./types.js";

export interface ResolvedGroupPolicy {
  policy: "disabled" | "allowlist" | "open";
  channelAllowlist?: string[];
  guildAllowlist?: string[];
}

export function resolveGroupPolicy(account: DiscordAccountConfig): ResolvedGroupPolicy {
  const g = account.groupAccess;
  if (g?.policy || g?.channelAllowlist?.length || g?.guildAllowlist?.length) {
    return {
      policy: g.policy ?? "allowlist",
      channelAllowlist: g.channelAllowlist,
      guildAllowlist: g.guildAllowlist,
    };
  }
  return { policy: "allowlist" };
}

export function isDmAllowed(account: DiscordAccountConfig, userId: string): boolean {
  const dm = account.dmAccess;
  if (dm?.policy) {
    switch (dm.policy) {
      case "disabled":
        return false;
      case "allowlist":
        return dm.allowlist?.includes(userId) ?? false;
    }
  }
  return false;
}

export function resolveToken(account: DiscordAccountConfig): string | null {
  if (account.token) return account.token;
  if (account.tokenEnv) return process.env[account.tokenEnv] ?? null;
  return null;
}

export function mapGuildsForReceive(
  guilds: Record<string, GuildConfig> | undefined,
): Record<string, GuildInboundConfig> | undefined {
  if (!guilds) return undefined;
  const out: Record<string, GuildInboundConfig> = {};
  for (const [id, g] of Object.entries(guilds)) {
    if (g.requireMention !== undefined) out[id] = { requireMention: g.requireMention };
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
