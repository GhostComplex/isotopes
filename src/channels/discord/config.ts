import type { DiscordAccountConfig } from "./types.js";

export interface ResolvedGroupPolicy {
  policy: "disabled" | "allowlist" | "open";
  channelAllowlist?: string[];
  guildAllowlist?: string[];
}

export function resolveGroupPolicy(account: DiscordAccountConfig): ResolvedGroupPolicy {
  const g = account.groupAccess;
  if (g?.policy || g?.channelAllowlist !== undefined || g?.guildAllowlist !== undefined) {
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
