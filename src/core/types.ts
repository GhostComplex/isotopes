// src/core/types.ts — Core interfaces for the Isotopes agent framework
// Zero coupling to any specific agent SDK — these are OUR types.

import type { SandboxConfig } from "../sandbox/config.js";

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** A text content block within a message. */
export interface TextContentBlock {
  type: 'text';
  text: string;
}

/** A tool result content block within a message. */
export interface ToolResultContentBlock {
  type: 'tool_result';
  output: string;
  isError?: boolean;
  toolCallId?: string;
  toolName?: string;
}

/** Union of content block types that can appear in a {@link Message}. */
export type MessageContentBlock = TextContentBlock | ToolResultContentBlock;

/** Wrap a plain text string into a single-element {@link MessageContentBlock} array. */
export function textContent(text: string): MessageContentBlock[] {
  return [{ type: 'text', text }];
}

/** Flatten an array of content blocks into a single plain-text string. */
export function messageContentToPlainText(content: MessageContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === 'text') {
        return block.text;
      }
      return block.output;
    })
    .join("\n");
}

/** A single message in a conversation between user, assistant, and tools. */
export interface Message {
  role: 'user' | 'assistant' | 'tool_result';
  content: MessageContentBlock[];
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Schema definition for a tool exposed to an agent. */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** File system access policy for agent tools. */
export interface FileToolPolicy {
  workspaceOnly?: boolean;
}

/** Per-agent tool policy (CLI access, file system restrictions, per-tool allow/deny). */
export interface AgentToolSettings {
  /** Enable web_search and web_fetch tools */
  web?: boolean;
  cli?: boolean;
  fs?: FileToolPolicy;
  /** Tool names to explicitly allow (if set, only these are available) */
  allow?: string[];
  /** Tool names to explicitly deny (takes precedence over allow) */
  deny?: string[];
}

// ---------------------------------------------------------------------------
// Usage — token consumption and cost tracking
// ---------------------------------------------------------------------------

/** Token usage and cost breakdown for a single LLM turn. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

// ---------------------------------------------------------------------------
// Events (streamed from AgentInstance.prompt)
// ---------------------------------------------------------------------------

/**
 * Discriminated union of events streamed from {@link AgentInstance.prompt}.
 *
 * Lifecycle events bracket turns (`turn_start` / `turn_end`) and the overall
 * agent run (`agent_end`). Content events carry text deltas, tool calls, and
 * tool results as they happen.
 */
export type AgentEvent =
  | { type: 'turn_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; output: string; isError?: boolean }
  | { type: 'turn_end'; usage?: Usage }
  | { type: 'agent_end'; messages: Message[]; stopReason?: string; errorMessage?: string }
  | { type: 'error'; error: Error };

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

/**
 * A running agent instance that can be prompted and yields streaming events.
 *
 * Created by {@link AgentCore.createAgent} and managed by {@link AgentManager}.
 */
export interface AgentInstance {
  prompt(input: string | Message[]): AsyncIterable<AgentEvent>;
  abort(): void;
  steer(msg: Message): void;
  followUp(msg: Message): void;
  /** Force context compaction for overflow recovery. Returns true if compaction occurred. */
  forceCompact?(): Promise<boolean>;
  /** Clear internal message state before prompting with fresh context */
  clearMessages?(): void;
  /** Get current messages from the agent instance (for persisting to SessionStore) */
  getMessages?(): Message[];
}

// ---------------------------------------------------------------------------
// Agent core — pluggable backend
// ---------------------------------------------------------------------------

/** Pluggable backend that creates {@link AgentInstance}s from configuration. */
export interface AgentCore {
  createAgent(config: AgentConfig): AgentInstance;
}

// ---------------------------------------------------------------------------
// Agent manager
// ---------------------------------------------------------------------------

/** Registry for creating, retrieving, updating, and deleting agents. */
export interface AgentManager {
  create(config: AgentConfig): Promise<AgentInstance>;
  get(id: string): AgentInstance | undefined;
  list(): AgentConfig[];
  update(id: string, updates: Partial<AgentConfig>): Promise<AgentInstance>;
  delete(id: string): Promise<void>;
  getPrompt(id: string): Promise<string>;
  updatePrompt(id: string, prompt: string): Promise<void>;
  /** Reload workspace context for an agent (hot-reload support) */
  reloadWorkspace(id: string): Promise<void>;
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

/** Transport-specific metadata attached to a session (channel, thread, etc.). */
export interface SessionMetadata {
  key?: string;                        // Unique key for session lookup (e.g., discord:{botId}:channel:{id}:{agentId})
  transport: 'discord' | 'feishu' | 'web';
  channelId?: string;
  channelName?: string;
  guildName?: string;
  threadId?: string;
  /** If true, session is exempt from TTL-based cleanup */
  persistent?: boolean;
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
  addMessage(sessionId: string, message: Message): Promise<void>;
  getMessages(sessionId: string): Promise<Message[]>;
  delete(sessionId: string): Promise<void>;
  /** List all sessions (lightweight, no message bodies). */
  list(): Promise<Session[]>;
  /** Clear all messages from a session (keeps session metadata, clears history) */
  clearMessages(sessionId: string): Promise<void>;
  /** Replace all messages in a session (used by compaction) */
  setMessages(sessionId: string, messages: Message[]): Promise<void>;
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

/** Discord account configuration within the channels section */
export interface DiscordAccountConfig {
  token?: string;
  tokenEnv?: string;
  groupPolicy?: string;
  /** Per-guild configuration keyed by guild ID */
  guilds?: Record<string, GuildConfig>;
  /** Thread binding configuration for auto-binding threads to agent sessions */
  threadBindings?: ThreadBindingConfig;
  /** Whether to respond to messages from other bots. Default: false */
  allowBots?: boolean;
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
  /** Compaction mode. Default: 'safeguard' */
  mode: CompactionMode;
  /** Maximum context window size in tokens. Default: 128000 */
  contextWindow?: number;
  /** Threshold ratio (0–1) at which compaction triggers. Default: 0.8 for safeguard, 0.5 for aggressive */
  threshold?: number;
  /** Number of recent messages to preserve (not summarized). Default: 10 */
  preserveRecent?: number;
}

// ---------------------------------------------------------------------------
// Thread bindings — auto-bind Discord threads to agent sessions
// ---------------------------------------------------------------------------

/** Per-agent thread control configuration */
export interface ThreadControlConfig {
  /** Whether to respond to messages in threads. Default: true */
  respond?: boolean;
  /** Whether to include thread messages in channel history context. Default: true */
  observe?: boolean;
}

/** Configuration for automatic thread-to-session binding */
export interface ThreadBindingConfig {
  /** Whether thread binding is enabled */
  enabled: boolean;
  /** Whether to spawn ACP sessions when threads are created (M3.2+) */
  spawnAcpSessions?: boolean;
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
  /** Associated ACP session ID (populated in M3.2+) */
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
