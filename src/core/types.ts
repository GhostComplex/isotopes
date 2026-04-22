// src/core/types.ts — Core interfaces for the Isotopes agent framework

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import type { SandboxConfig } from "../sandbox/config.js";
import type { ReplyToMode } from "../transports/reply-directive.js";

// ---------------------------------------------------------------------------
// Re-exports from SDK
// ---------------------------------------------------------------------------

export type { AgentMessage, AgentEvent } from "@mariozechner/pi-agent-core";
export type { Usage } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface FileToolPolicy {
  workspaceOnly?: boolean;
}

export interface AgentToolSettings {
  web?: boolean;
  cli?: boolean;
  fs?: FileToolPolicy;
  allow?: string[];
  deny?: string[];
}

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

/** LLM provider connection configuration (API type, base URL, credentials). */
export interface ProviderConfig {
  type: 'openai-proxy' | 'anthropic-proxy' | 'openai' | 'anthropic';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Agent config & instance
// ---------------------------------------------------------------------------

/** Complete configuration needed to create an {@link AgentInstance}. */
export interface AgentConfig {
  id: string;
  systemPrompt: string;
  tools?: Tool[];
  toolSettings?: AgentToolSettings;
  provider?: ProviderConfig;
  /** Context compaction configuration */
  compaction?: CompactionConfig;
  /** Sandbox execution configuration */
  sandbox?: SandboxConfig;
  /** Heartbeat interval in milliseconds (0 or undefined = disabled) */
  heartbeatInterval?: number;
  /** Custom heartbeat prompt (overrides the default) */
  heartbeatPrompt?: string;
  /**
   * Coding mode controls how the agent handles code modifications:
   * - 'subagent': Force all code changes through spawn_subagent (removes write_file, edit)
   * - 'direct': Agent can modify files directly (default behavior)
   * - 'auto': Agent chooses based on task complexity (default)
   */
  codingMode?: "subagent" | "direct" | "auto";
}

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

/** A conversation session binding an agent to a transport channel. */
export interface Session {
  id: string;
  agentId: string;
  metadata?: SessionMetadata;
  lastActiveAt: Date;
}

/** Per-run metadata for a subagent session (presence flags this as a subagent run). */
export interface SubagentSessionMetadata {
  parentAgentId: string;
  parentSessionId?: string;
  taskId: string;
  backend: string;
  cwd?: string;
  prompt?: string;
  /** Populated on terminal event (done/error). */
  exitCode?: number;
  costUsd?: number;
  durationMs?: number;
  error?: string;
}

/**
 * Session metadata. `transport` is set for sessions originating from a chat
 * transport (discord/feishu/web). Subagent runs have `subagent` populated
 * and no `transport` — use `metadata.subagent !== undefined` as the
 * discriminator.
 */
export interface SessionMetadata {
  key?: string;                        // Unique key for session lookup (e.g., discord:{botId}:channel:{id}:{agentId})
  transport?: 'discord' | 'feishu' | 'web';
  channelId?: string;
  channelName?: string;
  guildName?: string;
  threadId?: string;
  /** If true, session is exempt from TTL-based cleanup */
  persistent?: boolean;
  /** Subagent run metadata; presence indicates the session backs a subagent run. */
  subagent?: SubagentSessionMetadata;
}

/** Session TTL and cleanup configuration */
export interface SessionConfig {
  /** Session time-to-live in seconds. Default: 86400 (24 hours) */
  ttl?: number;
  /** Interval between cleanup sweeps in seconds. Default: 3600 (1 hour) */
  cleanupInterval?: number;
}

/** Configuration for the session store (data directory, limits, TTL). */
export interface SessionStoreConfig {
  dataDir: string;
  maxSessions?: number;       // default: 100
  maxTotalSizeMB?: number;    // default: 100
  session?: SessionConfig;
}

/** Persistent store for sessions and their message histories. */
export interface SessionStore {
  create(agentId: string, metadata?: SessionMetadata): Promise<Session>;
  get(sessionId: string): Promise<Session | undefined>;
  findByKey(key: string): Promise<Session | undefined>;
  addMessage(sessionId: string, message: AgentMessage): Promise<void>;
  getMessages(sessionId: string): Promise<AgentMessage[]>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<Session[]>;
  clearMessages(sessionId: string): Promise<void>;
  setMessages(sessionId: string, messages: AgentMessage[]): Promise<void>;
  setMetadata(sessionId: string, patch: Partial<SessionMetadata>): Promise<void>;
  /** Get the underlying SDK SessionManager for a session (for AgentSession creation). */
  getSessionManager(sessionId: string): Promise<import("@mariozechner/pi-coding-agent").SessionManager | undefined>;
}

// ---------------------------------------------------------------------------
// Bindings — route messages to agents by (channel, accountId, peer)
// ---------------------------------------------------------------------------

/** Peer kind: group channel, direct message, or thread */
export type PeerKind = 'group' | 'dm' | 'thread';

/** Peer identifier — a specific chat target within a channel+account */
export interface BindingPeer {
  kind: PeerKind;
  id: string;
}

/** Match criteria for a binding rule */
export interface BindingMatch {
  /** Transport channel type (e.g. "discord", "feishu") */
  channel: string;
  /** Account identifier within that channel */
  accountId?: string;
  /** Specific peer (group/dm/thread) to scope the binding */
  peer?: BindingPeer;
}

/** A binding ties an agent to a (channel, accountId, peer) pattern */
export interface Binding {
  agentId: string;
  match: BindingMatch;
}

// ---------------------------------------------------------------------------
// Channel config — per-guild/group settings
// ---------------------------------------------------------------------------

/** Per-guild (Discord) or per-group (Feishu) configuration */
export interface GuildConfig {
  /** Whether the bot must be @mentioned to respond. Default: true */
  requireMention?: boolean;
  /** Per-guild context configuration overrides */
  context?: {
    /** Max user turns to include in prompt context */
    historyTurns?: number;
    /** Enable channel history buffer */
    channelHistory?: boolean;
    /** Max entries in channel history buffer */
    channelHistoryLimit?: number;
  };
}

/** Per-account Discord context configuration */
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

/** Per-account Discord subagent streaming configuration */
export interface DiscordAccountSubagentStreamingConfig {
  enabled?: boolean;
  showToolCalls?: boolean;
}

/** Discord account configuration within the channels section */
export interface DiscordAccountConfig {
  /** Bot token (literal). Prefer `tokenEnv` for secrets. */
  token?: string;
  /** Env var name to read the bot token from. */
  tokenEnv?: string;
  /** Default agent ID for messages on this account. */
  defaultAgentId?: string;
  /** Channel/guild ID -> agent ID overrides. */
  agentBindings?: Record<string, string>;
  /** DM access control. */
  dmAccess?: {
    /** "disabled" (default) = ignore all DMs, "allowlist" = only from listed user IDs. */
    policy?: "disabled" | "allowlist";
    /** Discord user IDs allowed to DM when policy is "allowlist". */
    allowlist?: string[];
  };
  /** Group (guild) access control — parallel to `dmAccess`. */
  groupAccess?: {
    /** "allowlist" (default) = only listed channels/guilds, "disabled" = ignore all guild messages, "open" = accept all guild channels. */
    policy?: "disabled" | "allowlist" | "open";
    /** Channel IDs allowed when policy is "allowlist". */
    channelAllowlist?: string[];
    /** Guild (server) IDs allowed when policy is "allowlist". */
    guildAllowlist?: string[];
  };
  /** Per-guild configuration keyed by guild ID */
  guilds?: Record<string, GuildConfig>;
  /** Thread binding configuration for auto-binding threads to agent sessions */
  threadBindings?: ThreadBindingConfig;
  /** Subagent streaming behavior for this account. */
  subagentStreaming?: DiscordAccountSubagentStreamingConfig;
  /** Whether to respond to messages from other bots. Default: false */
  allowBots?: boolean;
  /** Context management configuration for this account. */
  context?: DiscordAccountContextConfig;
  /** Discord user IDs allowed to execute slash commands on this account. */
  adminUsers?: string[];
  replyToMode?: ReplyToMode;
}

/** Channels section of the configuration */
export interface ChannelsConfig {
  discord?: {
    enabled?: boolean;
    accounts?: Record<string, DiscordAccountConfig>;
  };
  feishu?: {
    enabled?: boolean;
    accounts?: Record<string, unknown>;
    groups?: Record<string, GuildConfig>;
  };
}

// ---------------------------------------------------------------------------
// Compaction — context window management
// ---------------------------------------------------------------------------

/** Compaction mode for managing context window size */
export type CompactionMode = 'off' | 'safeguard' | 'aggressive';

/** Configuration for context compaction */
export interface CompactionConfig {
  mode: CompactionMode;
  contextWindow?: number;
  threshold?: number;
  preserveRecent?: number;
  /** Absolute token reserve before compaction triggers. Overrides threshold if set. */
  reserveTokens?: number;
}

// ---------------------------------------------------------------------------
// Thread bindings — auto-bind Discord threads to agent sessions
// ---------------------------------------------------------------------------

/** Configuration for automatic thread-to-session binding */
export interface ThreadBindingConfig {
  /** Whether thread binding is enabled */
  enabled: boolean;
  /** Whether to automatically unbind thread when subagent completes (default: true) */
  autoUnbindOnComplete?: boolean;
  /** Whether to send a farewell message when unbinding (default: false) */
  sendFarewell?: boolean;
  /** Custom farewell message to send when unbinding */
  farewellMessage?: string;
}

/** A binding between a Discord thread and an agent session */
export interface ThreadBinding {
  /** Discord thread ID */
  threadId: string;
  /** ID of the parent channel the thread was created in */
  parentChannelId: string;
  /** Opaque session/task ID associated with this thread (e.g. subagent task ID) */
  sessionId?: string;
  /** Agent ID this thread is bound to */
  agentId: string;
  /** When the binding was created */
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Cron action config — for config-file-level cron job definitions
// ---------------------------------------------------------------------------

/** Action to perform when a config-level cron job triggers. */
export type CronActionConfig =
  | { type: "message"; content: string }
  | { type: "prompt"; prompt: string }
  | { type: "callback"; handler: string };

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Lifecycle interface for a message transport (Discord, Feishu, etc.). */
export interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Reply to a specific message by ID. If channelId is provided, skip O(n) channel scan. */
  reply?(messageId: string, content: string, channelId?: string): Promise<{ messageId: string }>;
  /** Add a reaction emoji to a specific message by ID. If channelId is provided, skip O(n) channel scan. */
  react?(messageId: string, emoji: string, channelId?: string): Promise<void>;
}
