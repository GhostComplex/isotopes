// src/core/config.ts — Configuration loading for Isotopes
// Loads agent and runtime configuration from YAML/JSON files.

import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type {
  AgentConfig,
  AgentToolSettings,
  Binding,
  BindingPeer,
  ChannelsConfig,
  CompactionConfig,
  CompactionMode,
  GuildConfig,
  PeerKind,
  ProviderConfig,
  SessionConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

/** Provider configuration in config file */
export interface ProviderConfigFile {
  type: "openai-proxy" | "anthropic-proxy" | "openai" | "anthropic";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  headers?: Record<string, string>;
}

/** Agent configuration in config file */
export interface AgentConfigFile {
  id: string;
  name: string;
  systemPrompt?: string;
  workspacePath?: string;
  tools?: AgentToolsConfigFile;
  provider?: ProviderConfigFile;
  compaction?: CompactionConfigFile;
}

export interface AgentToolsConfigFile {
  cli?: boolean;
  fs?: {
    workspaceOnly?: boolean;
  };
}

/** Compaction configuration in config file */
export interface CompactionConfigFile {
  mode?: string;
  contextWindow?: number;
  threshold?: number;
  preserveRecent?: number;
}

/** Session management configuration in config file */
export interface SessionConfigFile {
  /** Session time-to-live in seconds */
  ttl?: number;
  /** Interval between cleanup sweeps in seconds */
  cleanupInterval?: number;
}

/** Peer reference in binding config */
export interface BindingPeerConfigFile {
  kind: string;
  id: string;
}

/** Match criteria in binding config */
export interface BindingMatchConfigFile {
  channel: string;
  accountId?: string;
  peer?: BindingPeerConfigFile;
}

/** A single binding entry in config file */
export interface BindingConfigFile {
  agentId: string;
  match: BindingMatchConfigFile;
}

/** Discord transport configuration */
export interface DiscordConfigFile {
  token?: string;
  tokenEnv?: string;
  defaultAgentId?: string;
  agentBindings?: Record<string, string>;
  allowDMs?: boolean;
  channelAllowlist?: string[];
  /** Thread binding configuration for auto-binding threads to agent sessions */
  threadBindings?: ThreadBindingConfigFile;
}

/** Thread binding configuration in config file */
export interface ThreadBindingConfigFile {
  /** Whether thread binding is enabled */
  enabled?: boolean;
  /** Whether to spawn ACP sessions when threads are created (M3.2+) */
  spawnAcpSessions?: boolean;
}

/** Root configuration file structure */
export interface IsotopesConfigFile {
  /** Default provider for all agents */
  provider?: ProviderConfigFile;
  /** Default tool policy/guards for all agents */
  tools?: AgentToolsConfigFile;
  /** Default compaction config for all agents */
  compaction?: CompactionConfigFile;
  /** Session management (TTL, cleanup) */
  session?: SessionConfigFile;
  /** Agent definitions */
  agents: AgentConfigFile[];
  /** Agent ↔ Channel bindings */
  bindings?: BindingConfigFile[];
  /** Discord transport config */
  discord?: DiscordConfigFile;
  /** Channel configurations (per-guild/group settings) */
  channels?: ChannelsConfig;
}

export function resolveToolSettings(
  agentTools?: AgentToolsConfigFile,
  defaultTools?: AgentToolsConfigFile,
): AgentToolSettings {
  return {
    cli: agentTools?.cli ?? defaultTools?.cli ?? false,
    fs: {
      workspaceOnly: agentTools?.fs?.workspaceOnly ?? defaultTools?.fs?.workspaceOnly ?? true,
    },
  };
}

const VALID_COMPACTION_MODES = new Set<string>(["off", "safeguard", "aggressive"]);

/**
 * Resolve compaction config, merging agent-level overrides with defaults.
 * Returns undefined if compaction is not configured at all.
 */
export function resolveCompactionConfigFromFile(
  agentCompaction?: CompactionConfigFile,
  defaultCompaction?: CompactionConfigFile,
): CompactionConfig | undefined {
  // If neither agent nor default has compaction config, return undefined
  if (!agentCompaction && !defaultCompaction) return undefined;

  const rawMode = agentCompaction?.mode ?? defaultCompaction?.mode ?? "safeguard";

  if (!VALID_COMPACTION_MODES.has(rawMode)) {
    throw new Error(
      `Invalid compaction mode "${rawMode}" (must be off, safeguard, or aggressive)`,
    );
  }

  const mode = rawMode as CompactionMode;

  return {
    mode,
    contextWindow: agentCompaction?.contextWindow ?? defaultCompaction?.contextWindow,
    threshold: agentCompaction?.threshold ?? defaultCompaction?.threshold,
    preserveRecent: agentCompaction?.preserveRecent ?? defaultCompaction?.preserveRecent,
  };
}

/**
 * Resolve session config from the config file.
 * Returns undefined if no session config is provided.
 * Validates that ttl and cleanupInterval are positive numbers.
 */
export function resolveSessionConfig(
  sessionConfig?: SessionConfigFile,
): SessionConfig | undefined {
  if (!sessionConfig) return undefined;

  if (sessionConfig.ttl !== undefined && (typeof sessionConfig.ttl !== "number" || sessionConfig.ttl <= 0)) {
    throw new Error(`Invalid session.ttl "${sessionConfig.ttl}" (must be a positive number)`);
  }
  if (sessionConfig.cleanupInterval !== undefined && (typeof sessionConfig.cleanupInterval !== "number" || sessionConfig.cleanupInterval <= 0)) {
    throw new Error(`Invalid session.cleanupInterval "${sessionConfig.cleanupInterval}" (must be a positive number)`);
  }

  return {
    ...(sessionConfig.ttl !== undefined && { ttl: sessionConfig.ttl }),
    ...(sessionConfig.cleanupInterval !== undefined && { cleanupInterval: sessionConfig.cleanupInterval }),
  };
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Load configuration from a file (YAML or JSON).
 * Supports environment variable substitution in string values.
 */
export async function loadConfig(filePath: string): Promise<IsotopesConfigFile> {
  const content = await fs.readFile(filePath, "utf-8");
  const ext = path.extname(filePath).toLowerCase();

  let config: IsotopesConfigFile;

  if (ext === ".yaml" || ext === ".yml") {
    config = YAML.parse(content) as IsotopesConfigFile;
  } else if (ext === ".json") {
    config = JSON.parse(content) as IsotopesConfigFile;
  } else {
    // Try YAML first, then JSON
    try {
      config = YAML.parse(content) as IsotopesConfigFile;
    } catch {
      config = JSON.parse(content) as IsotopesConfigFile;
    }
  }

  // Validate required fields
  if (!config.agents || !Array.isArray(config.agents)) {
    throw new Error("Config must have an 'agents' array");
  }

  // Process environment variables
  return processEnvVars(config);
}

/**
 * Convert config file agent to AgentConfig.
 */
export function toAgentConfig(
  agent: AgentConfigFile,
  defaultProvider?: ProviderConfigFile,
  defaultTools?: AgentToolsConfigFile,
  defaultCompaction?: CompactionConfigFile,
): AgentConfig {
  const compaction = resolveCompactionConfigFromFile(agent.compaction, defaultCompaction);

  return {
    id: agent.id,
    name: agent.name,
    systemPrompt: agent.systemPrompt ?? "",
    workspacePath: agent.workspacePath,
    toolSettings: resolveToolSettings(agent.tools, defaultTools),
    provider: (agent.provider ?? defaultProvider) as ProviderConfig | undefined,
    ...(compaction ? { compaction } : {}),
  };
}

const VALID_PEER_KINDS = new Set<string>(["group", "dm", "thread"]);

/**
 * Convert config file bindings to Binding[].
 * Validates that all referenced agentIds exist and peer kinds are valid.
 */
export function toBindings(
  bindingsConfig: BindingConfigFile[] | undefined,
  agents: AgentConfigFile[],
): Binding[] {
  if (!bindingsConfig || bindingsConfig.length === 0) return [];

  const agentIds = new Set(agents.map((a) => a.id));

  return bindingsConfig.map((entry, i) => {
    // Validate agentId exists
    if (!agentIds.has(entry.agentId)) {
      throw new Error(
        `bindings[${i}]: agentId "${entry.agentId}" does not match any defined agent`,
      );
    }

    // Validate match.channel is present
    if (!entry.match?.channel) {
      throw new Error(`bindings[${i}]: match.channel is required`);
    }

    // Validate peer kind if present
    if (entry.match.peer) {
      if (!VALID_PEER_KINDS.has(entry.match.peer.kind)) {
        throw new Error(
          `bindings[${i}]: invalid peer.kind "${entry.match.peer.kind}" (must be group, dm, or thread)`,
        );
      }
      if (!entry.match.peer.id) {
        throw new Error(`bindings[${i}]: peer.id is required when peer is specified`);
      }
    }

    const binding: Binding = {
      agentId: entry.agentId,
      match: {
        channel: entry.match.channel,
        ...(entry.match.accountId !== undefined && { accountId: entry.match.accountId }),
        ...(entry.match.peer !== undefined && {
          peer: {
            kind: entry.match.peer.kind as PeerKind,
            id: String(entry.match.peer.id),
          } satisfies BindingPeer,
        }),
      },
    };

    return binding;
  });
}

/**
 * Get Discord token from config (supports env var reference).
 */
export function getDiscordToken(discord: DiscordConfigFile): string {
  if (discord.token) {
    return discord.token;
  }
  if (discord.tokenEnv) {
    const token = process.env[discord.tokenEnv];
    if (!token) {
      throw new Error(`Environment variable ${discord.tokenEnv} is not set`);
    }
    return token;
  }
  throw new Error("Discord config must have either 'token' or 'tokenEnv'");
}

// ---------------------------------------------------------------------------
// Channel config helpers
// ---------------------------------------------------------------------------

/**
 * Look up the GuildConfig for a specific Discord guild under a given account.
 * Returns undefined if no guild-specific config exists.
 */
export function getDiscordGuildConfig(
  channels: ChannelsConfig | undefined,
  accountId: string,
  guildId: string,
): GuildConfig | undefined {
  return channels?.discord?.accounts?.[accountId]?.guilds?.[guildId];
}

/**
 * Resolve whether @mention is required for a given Discord guild.
 * Default: true (only respond when @mentioned).
 */
export function isRequireMention(
  channels: ChannelsConfig | undefined,
  accountId: string,
  guildId: string,
): boolean {
  const guildConfig = getDiscordGuildConfig(channels, accountId, guildId);
  return guildConfig?.requireMention ?? true;
}

// ---------------------------------------------------------------------------
// Environment variable processing
// ---------------------------------------------------------------------------

/**
 * Recursively process environment variable substitutions.
 * Supports ${VAR} and ${VAR:-default} syntax.
 */
function processEnvVars<T>(obj: T): T {
  if (typeof obj === "string") {
    return substituteEnvVars(obj) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => processEnvVars(item)) as T;
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = processEnvVars(value);
    }
    return result as T;
  }
  return obj;
}

/**
 * Substitute environment variables in a string.
 * ${VAR} — required, throws if not set
 * ${VAR:-default} — optional with default
 */
function substituteEnvVars(str: string): string {
  // Match ${VAR} or ${VAR:-default}
  return str.replace(/\$\{([^}]+)\}/g, (match, expr: string) => {
    const [varName, defaultValue] = expr.split(":-");
    const value = process.env[varName.trim()];

    if (value !== undefined) {
      return value;
    }
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    // Don't throw for unset vars without default — might be intentional
    return match;
  });
}
