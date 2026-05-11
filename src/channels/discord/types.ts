// plugins/discord/types.ts — Discord-specific type definitions
// Moved from src/core/types.ts to decouple Discord from core.

// ---------------------------------------------------------------------------
// Channel config
// ---------------------------------------------------------------------------

export interface GuildConfig {
  requireMention?: boolean;
  /** Default true. Set false to ignore all messages in threads under this guild. */
  respondInThreads?: boolean;
}

export interface DiscordAccountConfig {
  token?: string;
  tokenEnv?: string;
  defaultAgentId?: string;
  agentBindings?: Record<string, string>;
  dmAccess?: {
    policy?: "disabled" | "allowlist";
    allowlist?: string[];
  };
  groupAccess?: {
    policy?: "disabled" | "allowlist" | "open";
    channelAllowlist?: string[];
    guildAllowlist?: string[];
  };
  guilds?: Record<string, GuildConfig>;
  allowBots?: boolean;
}

export interface DiscordChannelsConfig {
  accounts?: Record<string, DiscordAccountConfig>;
}

/** Per-guild config consumed by the inbound pipeline. */
export interface GuildInboundConfig {
  requireMention?: boolean;
  respondInThreads?: boolean;
}
