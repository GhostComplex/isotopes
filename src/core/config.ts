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
  CronActionConfig,
  PeerKind,
  ProviderConfig,
  SessionConfig,
} from "./types.js";
import type { AcpConfig, AcpPersistenceConfig } from "../acp/types.js";
import { resolveSandboxConfig, type SandboxConfig } from "../sandbox/config.js";
import { createLogger } from "./logger.js";

const log = createLogger("config");

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Assert that a value, if defined, is a positive number.
 * Throws with a descriptive error message if not.
 */
function assertPositiveNumber(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== "number" || value <= 0)) {
    throw new Error(`Invalid ${label} "${value}" (must be a positive number)`);
  }
}

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

/** Heartbeat configuration in config file */
export interface HeartbeatConfigFile {
  /** Enable heartbeat for this agent. Default: false */
  enabled?: boolean;
  /** Interval in seconds between heartbeat triggers. Default: 300 (5 min) */
  intervalSeconds?: number;
}

/** Per-agent cron task configuration (#193) */
export interface CronTaskConfigFile {
  name: string;
  /** Cron expression (e.g., "0 * * * *" = every hour) */
  schedule: string;
  /** Channel/session key to send prompt to */
  channel: string;
  /** Message to trigger agent with */
  prompt: string;
  /** Whether this task is enabled. Default: true */
  enabled?: boolean;
}

/** Agent configuration in config file */
export interface AgentConfigFile {
  id: string;
  /**
   * Explicit workspace directory for this agent (#214).
   * Absolute paths are used as-is; relative paths resolve from ISOTOPES_HOME.
   * When omitted, the default derivation (single → "workspace/", multi → "workspace-{id}/") is used.
   */
  workspace?: string;
  tools?: AgentToolsConfigFile;
  provider?: ProviderConfigFile;
  compaction?: CompactionConfigFile;
  sandbox?: SandboxConfigFile;
  /** Self-iteration configuration (M10) */
  selfIteration?: SelfIterationConfigFile;
  /** Heartbeat configuration (#191) */
  heartbeat?: HeartbeatConfigFile;
  /** Cron scheduled tasks (#193) */
  cron?: { tasks: CronTaskConfigFile[] };
  /** Additional workspace paths allowed for subagent cwd */
  allowedWorkspaces?: string[];
  /** Heartbeat interval in milliseconds (0 = disabled). */
  heartbeatInterval?: number;
  /** Custom heartbeat prompt (overrides the default). */
  heartbeatPrompt?: string;
  /**
   * Coding mode controls how the agent handles code modifications:
   * - 'subagent': Force all code through spawn_subagent (removes write_file, edit)
   * - 'direct': Agent can modify files directly
   * - 'auto': Agent chooses (default)
   */
  codingMode?: "subagent" | "direct" | "auto";
}

/** Self-iteration configuration in config file */
export interface SelfIterationConfigFile {
  /** Enable self-iteration tools. Default: false */
  enabled?: boolean;
  /** Allowed file patterns for iteration. Default includes workspace files and skills */
  allowedFiles?: string[];
  /** Create backups before overwriting files. Default: true */
  backup?: boolean;
}

export interface AgentToolsConfigFile {
  cli?: boolean;
  fs?: {
    workspaceOnly?: boolean;
  };
  /** Tool names to explicitly allow (if set, only these are available) */
  allow?: string[];
  /** Tool names to explicitly deny (takes precedence over allow) */
  deny?: string[];
}

/** Compaction configuration in config file */
export interface CompactionConfigFile {
  mode?: string;
  contextWindow?: number;
  threshold?: number;
  preserveRecent?: number;
}

/** Sandbox Docker configuration in config file */
export interface SandboxDockerConfigFile {
  image?: string;
  network?: string;
  extraHosts?: string[];
  cpuLimit?: number;
  memoryLimit?: string;
}

/** Sandbox execution configuration in config file */
export interface SandboxConfigFile {
  mode?: string;
  workspaceAccess?: string;
  docker?: SandboxDockerConfigFile;
}

// SessionConfig from core/types.ts is used directly — no separate config-file type needed
// since the config-file shape is identical to the runtime type.

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

/** Context management configuration (shared across transports) */
export interface ContextConfigFile {
  /** Max user turns to include in prompt context. Default: 20 */
  historyTurns?: number;
  /** Enable channel history buffer (lurking context). Default: true */
  channelHistory?: boolean;
  /** Max entries in channel history buffer per channel. Default: 20 */
  channelHistoryLimit?: number;
  /** Enable message deduplication. Default: true */
  dedupe?: boolean;
  /** Enable message debounce (combine rapid messages). Default: false */
  debounce?: boolean;
  /** Debounce window in milliseconds. Default: 1500 */
  debounceWindowMs?: number;
  /** Tool result pruning options */
  pruning?: {
    /** Number of recent assistant messages to protect from pruning. Default: 3 */
    protectRecent?: number;
    /** Head chars for soft trim. Default: 1500 */
    headChars?: number;
    /** Tail chars for soft trim. Default: 1500 */
    tailChars?: number;
  };
}

/** Per-account Discord bot configuration */
export interface DiscordAccountConfigFile {
  token?: string;
  tokenEnv?: string;
  defaultAgentId?: string;
  agentBindings?: Record<string, string>;
  /** Per-account overrides (optional) */
  allowDMs?: boolean;
  channelAllowlist?: string[];
}

/** Discord transport configuration */
export interface DiscordConfigFile {
  /** Multi-bot: keyed by account ID */
  accounts?: Record<string, DiscordAccountConfigFile>;
  /** Legacy single-bot fields (backward compat) */
  token?: string;
  tokenEnv?: string;
  defaultAgentId?: string;
  agentBindings?: Record<string, string>;
  allowDMs?: boolean;
  channelAllowlist?: string[];
  /** Thread binding configuration for auto-binding threads to agent sessions */
  threadBindings?: ThreadBindingConfigFile;
  /** Subagent Discord streaming configuration (M8) */
  subagentStreaming?: SubagentStreamingConfigFile;
  /** Whether to respond to messages from other bots. Default: false */
  allowBots?: boolean;
  /** Context management configuration */
  context?: ContextConfigFile;
  /** Discord user IDs allowed to execute slash commands */
  adminUsers?: string[];
}

/** Thread binding configuration in config file */
export interface ThreadBindingConfigFile {
  /** Whether thread binding is enabled */
  enabled?: boolean;
  /** Whether to spawn ACP sessions when threads are created (M3.2+) */
  spawnAcpSessions?: boolean;
}

/** Subagent Discord streaming configuration (M8) */
export interface SubagentStreamingConfigFile {
  /** Whether subagent streaming to Discord is enabled. Default: true */
  enabled?: boolean;
  /** Whether to show tool call details in Discord. Default: true */
  showToolCalls?: boolean;
}

/** Permission mode for subagent tool execution (M8) */
export type SubagentPermissionMode = "skip" | "allowlist" | "default";

/** Default allowed tools for subagent execution (M8) */
export const DEFAULT_SUBAGENT_ALLOWED_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "LS"];

/** Sub-agent execution configuration in config file (M7/M8) */
export interface SubagentConfigFile {
  /** Default acpx agent to use when spawning sub-agents */
  defaultAgent?: string;
  /** Agents allowed to be spawned as sub-agents */
  allowedAgents?: string[];
  /** Default timeout in seconds for sub-agent runs */
  timeout?: number;
  /** Default maximum turns per sub-agent run */
  maxTurns?: number;
  /**
   * Permission mode for subagent tool execution (M8)
   * - "skip" — Use --dangerously-skip-permissions (full access, no prompts)
   * - "allowlist" — Use --allowedTools with configured list (recommended)
   * - "default" — Use claude CLI defaults (interactive prompts, not suitable for automation)
   * Default: "allowlist"
   */
  permissionMode?: SubagentPermissionMode;
  /**
   * Tool allowlist for subagent execution (M8)
   * Only used when permissionMode: "allowlist"
   * Default: ["Read", "Write", "Edit", "Glob", "Grep", "LS"]
   */
  allowedTools?: string[];
  /**
   * Enable shell access for subagents (M8)
   * Adds "Bash" to allowedTools when permissionMode: "allowlist"
   * WARNING: Combined with permissionMode: "skip", this allows arbitrary command execution
   * Default: false
   */
  enableShell?: boolean;
  /** @deprecated Use permissionMode instead. Whether to auto-approve tool calls. Default: true */
  approveAll?: boolean;
  /** Whether to create Discord threads for sub-agent output. Default: true */
  useThread?: boolean;
  /** Whether to show tool call details in Discord. Default: true */
  showToolCalls?: boolean;
}

/** Resolved subagent configuration with defaults applied (M8) */
export interface ResolvedSubagentConfig {
  defaultAgent?: string;
  allowedAgents?: string[];
  timeout?: number;
  maxTurns?: number;
  permissionMode: SubagentPermissionMode;
  allowedTools: string[];
  useThread: boolean;
  showToolCalls: boolean;
}

/** ACP session persistence configuration in config file */
export interface AcpPersistenceConfigFile {
  /** Whether session persistence is enabled. Default: false */
  enabled?: boolean;
  /** Directory to store persisted session data. Default: $ISOTOPES_HOME/acp-sessions */
  dataDir?: string;
  /** Session TTL in seconds. Default: 86400 (24h) */
  ttl?: number;
  /** Cleanup interval in seconds. Default: 3600 (1h) */
  cleanupInterval?: number;
}

/** ACP (Agent Communication Protocol) configuration in config file */
export interface AcpConfigFile {
  /** Whether ACP is enabled. Default: false */
  enabled?: boolean;
  /** Backend type for agent communication */
  backend?: "acpx" | "claude-code" | "codex";
  /** Default agent ID to use when none is specified */
  defaultAgent?: string;
  /** Agent IDs allowed to participate in ACP sessions */
  allowedAgents?: string[];
  /** Sub-agent execution settings (M7/M8) */
  subagent?: SubagentConfigFile;
  /** Session persistence settings (#195) */
  persistence?: AcpPersistenceConfigFile;
}

/** Cron job configuration in config file */
export interface CronJobConfigFile {
  name: string;
  expression: string;
  agentId: string;
  action: CronActionConfig;
  enabled?: boolean;
}

/** Agent defaults — shared configuration inherited by all agents unless overridden */
export interface AgentDefaultsConfigFile {
  provider?: ProviderConfigFile;
  tools?: AgentToolsConfigFile;
  compaction?: CompactionConfigFile;
  sandbox?: SandboxConfigFile;
}

/** Raw config file structure — agents can be array or object form */
export interface IsotopesConfigFileRaw {
  /** Default provider for all agents */
  provider?: ProviderConfigFile;
  /** Default tool policy/guards for all agents */
  tools?: AgentToolsConfigFile;
  /** Default compaction config for all agents */
  compaction?: CompactionConfigFile;
  /** Default sandbox config for all agents */
  sandbox?: SandboxConfigFile;
  /** Session management (TTL, cleanup) */
  session?: SessionConfig;
  /** Agent definitions — array form or object with defaults + list */
  agents: AgentConfigFile[] | { defaults?: AgentDefaultsConfigFile; list: AgentConfigFile[] };
  /** Agent ↔ Channel bindings */
  bindings?: BindingConfigFile[];
  /** Discord transport config */
  discord?: DiscordConfigFile;
  /** Channel configurations (per-guild/group settings) */
  channels?: ChannelsConfig;
  /** ACP (Agent Communication Protocol) configuration */
  acp?: AcpConfigFile;
  /** Channel-level cron job definitions */
  cron?: CronJobConfigFile[];
  /**
   * @deprecated Moved to discord.threadBindings in M8.
   * Thread binding configuration for auto-binding threads to agent sessions.
   */
  threadBindings?: ThreadBindingConfigFile;
}

/** Normalized config — agents is always an array, agentDefaults extracted */
export interface IsotopesConfigFile extends Omit<IsotopesConfigFileRaw, "agents"> {
  agents: AgentConfigFile[];
  agentDefaults?: AgentDefaultsConfigFile;
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
    // allow/deny: agent-level overrides defaults entirely (not merged)
    allow: agentTools?.allow ?? defaultTools?.allow,
    deny: agentTools?.deny ?? defaultTools?.deny,
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
  sessionConfig?: SessionConfig,
): SessionConfig | undefined {
  if (!sessionConfig) return undefined;

  assertPositiveNumber(sessionConfig.ttl, "session.ttl");
  assertPositiveNumber(sessionConfig.cleanupInterval, "session.cleanupInterval");

  return {
    ttl: sessionConfig.ttl,
    cleanupInterval: sessionConfig.cleanupInterval,
  };
}

const VALID_ACP_BACKENDS = new Set<string>(["acpx", "claude-code", "codex"]);
const VALID_PERMISSION_MODES = new Set<SubagentPermissionMode>(["skip", "allowlist", "default"]);

/**
 * Resolve ACP config from the config file.
 * Returns undefined if ACP is not configured or not enabled.
 * Validates that backend is a known type.
 */
export function resolveAcpConfig(
  acpConfig?: AcpConfigFile,
): AcpConfig | undefined {
  if (!acpConfig || !acpConfig.enabled) return undefined;

  const backend = acpConfig.backend ?? "acpx";
  if (!VALID_ACP_BACKENDS.has(backend)) {
    throw new Error(
      `Invalid acp.backend "${backend}" (must be acpx, claude-code, or codex)`,
    );
  }

  if (!acpConfig.defaultAgent) {
    throw new Error("acp.defaultAgent is required when ACP is enabled");
  }

  let persistence: AcpPersistenceConfig | undefined;
  if (acpConfig.persistence?.enabled) {
    if (acpConfig.persistence.ttl !== undefined) {
      assertPositiveNumber(acpConfig.persistence.ttl, "acp.persistence.ttl");
    }
    if (acpConfig.persistence.cleanupInterval !== undefined) {
      assertPositiveNumber(acpConfig.persistence.cleanupInterval, "acp.persistence.cleanupInterval");
    }

    const home = process.env.ISOTOPES_HOME ?? path.join(process.env.HOME ?? "~", ".isotopes");
    persistence = {
      enabled: true,
      dataDir: acpConfig.persistence.dataDir ?? path.join(home, "acp-sessions"),
      ttl: acpConfig.persistence.ttl ?? 86_400,
      cleanupInterval: acpConfig.persistence.cleanupInterval ?? 3_600,
    };
  }

  return {
    enabled: true,
    backend,
    defaultAgent: acpConfig.defaultAgent,
    allowedAgents: acpConfig.allowedAgents,
    persistence,
  };
}

/**
 * Resolve subagent config with defaults applied (M8).
 * Validates permission mode and logs security warnings.
 */
export function resolveSubagentConfig(
  subagentConfig?: SubagentConfigFile,
): ResolvedSubagentConfig {
  const permissionMode = subagentConfig?.permissionMode ?? "allowlist";
  
  // Validate permission mode
  if (!VALID_PERMISSION_MODES.has(permissionMode)) {
    throw new Error(
      `Invalid acp.subagent.permissionMode "${permissionMode}" (must be skip, allowlist, or default)`,
    );
  }

  // Build allowed tools list
  let allowedTools = subagentConfig?.allowedTools ?? [...DEFAULT_SUBAGENT_ALLOWED_TOOLS];
  
  // Add Bash if enableShell is true and not already in list
  if (subagentConfig?.enableShell && !allowedTools.includes("Bash")) {
    allowedTools = [...allowedTools, "Bash"];
  }

  // Security warnings (M8.1)
  if (permissionMode === "skip") {
    log.warn(
      "⚠️  SECURITY WARNING: acp.subagent.permissionMode is set to 'skip'. " +
      "Sub-agents will have unrestricted tool access without any permission prompts. " +
      "This is NOT recommended for production use.",
    );
    
    if (subagentConfig?.enableShell) {
      log.warn(
        "⚠️  CRITICAL SECURITY WARNING: permissionMode 'skip' combined with enableShell: true " +
        "allows sub-agents to execute ARBITRARY SHELL COMMANDS without approval. " +
        "Only use this configuration in fully trusted, isolated environments.",
      );
    }
  }

  // Handle deprecated approveAll
  if (subagentConfig?.approveAll !== undefined) {
    log.warn(
      "⚠️  DEPRECATION WARNING: acp.subagent.approveAll is deprecated. " +
      "Use acp.subagent.permissionMode instead. " +
      "(approveAll: true → permissionMode: 'skip', approveAll: false → permissionMode: 'default')",
    );
  }

  return {
    defaultAgent: subagentConfig?.defaultAgent,
    allowedAgents: subagentConfig?.allowedAgents,
    timeout: subagentConfig?.timeout,
    maxTurns: subagentConfig?.maxTurns,
    permissionMode,
    allowedTools,
    useThread: subagentConfig?.useThread ?? true,
    showToolCalls: subagentConfig?.showToolCalls ?? true,
  };
}

/**
 * Resolve sandbox config from config file types.
 * Delegates to the sandbox module's resolveSandboxConfig for validation and merging.
 * Returns undefined if no sandbox config is provided at all.
 */
export function resolveSandboxConfigFromFile(
  agentId: string,
  agentSandbox?: SandboxConfigFile,
  defaultSandbox?: SandboxConfigFile,
): SandboxConfig | undefined {
  if (!agentSandbox && !defaultSandbox) return undefined;

  const defaults = defaultSandbox
    ? toSandboxConfig(defaultSandbox)
    : undefined;
  const override = agentSandbox
    ? toSandboxConfig(agentSandbox)
    : undefined;

  return resolveSandboxConfig(agentId, defaults, override);
}

/**
 * Convert a config-file sandbox entry to a typed SandboxConfig.
 */
function toSandboxConfig(file: SandboxConfigFile): SandboxConfig {
  return {
    mode: (file.mode ?? "off") as SandboxConfig["mode"],
    ...(file.workspaceAccess !== undefined && {
      workspaceAccess: file.workspaceAccess as SandboxConfig["workspaceAccess"],
    }),
    ...(file.docker && {
      docker: {
        image: file.docker.image ?? "isotopes-sandbox:latest",
        ...(file.docker.network !== undefined && {
          network: file.docker.network as "bridge" | "host" | "none",
        }),
        ...(file.docker.extraHosts && { extraHosts: file.docker.extraHosts }),
        ...(file.docker.cpuLimit !== undefined && { cpuLimit: file.docker.cpuLimit }),
        ...(file.docker.memoryLimit !== undefined && { memoryLimit: file.docker.memoryLimit }),
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Normalize Discord config: if legacy single-bot fields (token/tokenEnv) are present
 * without an explicit `accounts` map, wrap them into `accounts: { default: {...} }`.
 * This ensures downstream code always deals with the multi-account shape.
 */
export function normalizeDiscordAccounts(config: IsotopesConfigFile): void {
  if (!config.discord) return;

  // If accounts already defined, nothing to normalize
  if (config.discord.accounts && Object.keys(config.discord.accounts).length > 0) return;

  // If legacy token/tokenEnv exists, wrap into accounts.default
  if (config.discord.token || config.discord.tokenEnv) {
    config.discord.accounts = {
      default: {
        token: config.discord.token,
        tokenEnv: config.discord.tokenEnv,
        defaultAgentId: config.discord.defaultAgentId,
        agentBindings: config.discord.agentBindings,
        allowDMs: config.discord.allowDMs,
        channelAllowlist: config.discord.channelAllowlist,
      },
    };
    log.debug("Normalized legacy discord.token into discord.accounts.default");
  }
}

/**
 * Migrate deprecated top-level threadBindings to discord.threadBindings (M8).
 * Logs a deprecation warning if migration occurs.
 */
function migrateThreadBindings(config: IsotopesConfigFile): void {
  if (config.threadBindings && !config.discord?.threadBindings) {
    log.warn(
      "⚠️  DEPRECATION WARNING: Top-level 'threadBindings' configuration is deprecated. " +
      "Please move it to 'discord.threadBindings'. Auto-migrating for this session.",
    );
    
    if (!config.discord) {
      config.discord = {};
    }
    config.discord.threadBindings = config.threadBindings;
  }
}

/**
 * Load configuration from a file (YAML or JSON).
 * Supports environment variable substitution in string values.
 * Normalizes the agents union type so downstream always sees agents as an array.
 */
export async function loadConfig(filePath: string): Promise<IsotopesConfigFile> {
  const content = await fs.readFile(filePath, "utf-8");
  const ext = path.extname(filePath).toLowerCase();

  let raw: IsotopesConfigFileRaw;

  if (ext === ".yaml" || ext === ".yml") {
    raw = YAML.parse(content) as IsotopesConfigFileRaw;
  } else if (ext === ".json") {
    raw = JSON.parse(content) as IsotopesConfigFileRaw;
  } else {
    // Try YAML first, then JSON
    try {
      raw = YAML.parse(content) as IsotopesConfigFileRaw;
    } catch {
      raw = JSON.parse(content) as IsotopesConfigFileRaw;
    }
  }

  // Normalize agents: support both array form and object form { defaults, list }
  let agentList: AgentConfigFile[];
  let agentDefaults: AgentDefaultsConfigFile | undefined;

  if (Array.isArray(raw.agents)) {
    // Legacy array form — no defaults
    agentList = raw.agents;
  } else if (
    raw.agents &&
    typeof raw.agents === "object" &&
    "list" in raw.agents
  ) {
    // Object form — extract defaults and normalize to array
    if (!Array.isArray(raw.agents.list)) {
      throw new Error("Config agents.list must be an array");
    }
    agentList = raw.agents.list;
    agentDefaults = raw.agents.defaults;
  } else {
    throw new Error("Config must have an 'agents' array or an 'agents' object with a 'list' field");
  }

  if (agentList.length === 0) {
    throw new Error("Config must have at least one agent");
  }

  // Build normalized config — agents is always an array from here on
  let config: IsotopesConfigFile = {
    ...raw,
    agents: agentList,
    agentDefaults,
  };

  // Process environment variables
  config = processEnvVars(config);

  // Normalize discord accounts (legacy single-bot → multi-account)
  normalizeDiscordAccounts(config);

  // M8: Migrate deprecated threadBindings
  migrateThreadBindings(config);

  return config;
}

/**
 * Convert config file agent to AgentConfig.
 * Merge priority: agent > agentDefaults > global
 */
export function toAgentConfig(
  agent: AgentConfigFile,
  agentDefaults?: AgentDefaultsConfigFile,
  globalProvider?: ProviderConfigFile,
  globalTools?: AgentToolsConfigFile,
  globalCompaction?: CompactionConfigFile,
  globalSandbox?: SandboxConfigFile,
): AgentConfig {
  // 3-tier merge: agent > defaults > global (shallow replace per block)
  const provider = agent.provider ?? agentDefaults?.provider ?? globalProvider;
  const tools = agent.tools ?? agentDefaults?.tools ?? globalTools;
  const agentCompaction = agent.compaction ?? agentDefaults?.compaction ?? globalCompaction;
  const agentSandboxFile = agent.sandbox ?? agentDefaults?.sandbox ?? globalSandbox;

  const compaction = resolveCompactionConfigFromFile(agentCompaction);
  const sandbox = agentSandboxFile
    ? resolveSandboxConfigFromFile(agent.id, agentSandboxFile)
    : undefined;

  return {
    id: agent.id,
    systemPrompt: "",
    toolSettings: resolveToolSettings(tools),
    provider: provider as ProviderConfig | undefined,
    compaction,
    sandbox,
    heartbeatInterval: agent.heartbeatInterval,
    heartbeatPrompt: agent.heartbeatPrompt,
    codingMode: agent.codingMode,
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
 * Accepts either a DiscordConfigFile (legacy) or a DiscordAccountConfigFile (multi-bot).
 */
export function getDiscordToken(discord: DiscordConfigFile | DiscordAccountConfigFile): string {
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
