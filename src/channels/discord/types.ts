// plugins/discord/types.ts — Discord-specific type definitions
// Moved from src/core/types.ts to decouple Discord from core.

// ---------------------------------------------------------------------------
// Thread bindings
// ---------------------------------------------------------------------------

export interface ThreadBindingConfig {
  enabled: boolean;
  autoUnbindOnComplete?: boolean;
  sendFarewell?: boolean;
  farewellMessage?: string;
}

export interface ThreadBinding {
  threadId: string;
  parentChannelId: string;
  sessionId?: string;
  agentId: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Channel config
// ---------------------------------------------------------------------------

export interface GuildConfig {
  requireMention?: boolean;
  context?: {
    channelHistory?: boolean;
    channelHistoryLimit?: number;
  };
}

export interface DiscordAccountContextConfig {
  channelHistory?: boolean;
  channelHistoryLimit?: number;
  dedupe?: boolean;
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
  threadBindings?: ThreadBindingConfig;
  allowBots?: boolean;
  context?: DiscordAccountContextConfig;
  adminUsers?: string[];
}

export interface DiscordChannelsConfig {
  enabled?: boolean;
  accounts?: Record<string, DiscordAccountConfig>;
}
