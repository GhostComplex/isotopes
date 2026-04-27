// plugins/discord/types.ts — Discord-specific type definitions
// Moved from src/core/types.ts to decouple Discord from core.

import type { ReplyToMode } from "./reply-directive.js";

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
    historyTurns?: number;
    channelHistory?: boolean;
    channelHistoryLimit?: number;
  };
}

export interface DiscordAccountContextConfig {
  historyTurns?: number;
  channelHistory?: boolean;
  channelHistoryLimit?: number;
  dedupe?: boolean;
  debounce?: boolean;
  debounceWindowMs?: number;
  pruning?: {
    protectRecent?: number;
    headChars?: number;
    tailChars?: number;
  };
}

export interface DiscordAccountSpawnAgentStreamingConfig {
  enabled?: boolean;
  showToolCalls?: boolean;
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
  spawnAgentStreaming?: DiscordAccountSpawnAgentStreamingConfig;
  allowBots?: boolean;
  context?: DiscordAccountContextConfig;
  adminUsers?: string[];
  replyToMode?: ReplyToMode;
}

export interface DiscordChannelsConfig {
  enabled?: boolean;
  accounts?: Record<string, DiscordAccountConfig>;
}
