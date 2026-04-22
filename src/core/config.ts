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
  DiscordAccountConfig,
  PeerKind,
  ProviderConfig,
  SessionConfig,
} from "./types.js";
import { resolveSandboxConfig, type SandboxConfig } from "../sandbox/config.js";
import type { PluginConfigEntry } from "../plugins/types.js";
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
   * When omitted, defaults to "workspace-{id}/".
   */
  workspace?: string;
  tools?: AgentToolsConfigFile;
  provider?: ProviderConfigFile;
  compaction?: CompactionConfigFile;
  sandbox?: SandboxConfigFile;
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
  pidsLimit?: number;
  capDrop?: string[];
  capAdd?: string[];
  noNewPrivileges?: boolean;
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

/** Permission mode for subagent tool execution (M8) */
export type SubagentPermissionMode = "skip" | "allowlist" | "default";

/** Default allowed tools for subagent execution (M8) */
export const DEFAULT_SUBAGENT_ALLOWED_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "LS"];

/** Claude Agent SDK settings source — controls which `settings.json` files the spawned `claude` CLI loads. */
export type SettingSource = "user" | "project" | "local";

/** Sub-agent execution configuration in config file (M7/M8) */
export interface SubagentConfigFile {
  /** Whether subagent backend is enabled. Default: false */
  enabled?: boolean;
  /** Settings sources the SDK should load. Default: ["user"] (loads ~/.claude/settings.json — env, model, permissions). SDK default is [] (load nothing); pass [] to opt out. */
  settingSources?: SettingSource[];
  /** Default sub-agent to use when spawning sub-agents */
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
  settingSources?: SettingSource[];
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
  /** Channel configurations (Discord/Feishu accounts, per-guild settings) */
  channels?: ChannelsConfig;
  /** Sub-agent (Claude Agent SDK) configuration */
  subagent?: SubagentConfigFile;
  /** Channel-level cron job definitions */
  cron?: CronJobConfigFile[];
  /** Plugin configurations */
  plugins?: Record<string, PluginConfigEntry>;
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

const VALID_PERMISSION_MODES = new Set<SubagentPermissionMode>(["skip", "allowlist", "default"]);

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
      `Invalid subagent.permissionMode "${permissionMode}" (must be skip, allowlist, or default)`,
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
      "⚠️  SECURITY WARNING: subagent.permissionMode is set to 'skip'. " +
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

  return {
    defaultAgent: subagentConfig?.defaultAgent,
    allowedAgents: subagentConfig?.allowedAgents,
    timeout: subagentConfig?.timeout,
    maxTurns: subagentConfig?.maxTurns,
    permissionMode,
    allowedTools,
    useThread: subagentConfig?.useThread ?? true,
    showToolCalls: subagentConfig?.showToolCalls ?? true,
    ...(subagentConfig?.settingSources && { settingSources: subagentConfig.settingSources }),
  };
}

/**
 * Resolve sandbox config from config file types.
 *
 * Layered resolution: an agents-level config (from
 * `agents.defaults.sandbox` or top-level `sandbox`) provides image / docker /
 * workspaceAccess. Per-agent `sandbox` is a partial override — typically just
 * `{ mode: "off" }` to opt a single agent out. Per-agent `sandbox.docker` is
 * rejected because the runtime maintains a single global ContainerManager.
 *
 * Returns undefined if no sandbox config is provided at any layer.
 */
export function resolveSandboxConfigFromFile(
  agentId: string,
  agentSandbox?: SandboxConfigFile,
  defaultSandbox?: SandboxConfigFile,
): SandboxConfig | undefined {
  if (!agentSandbox && !defaultSandbox) return undefined;

  if (agentSandbox?.docker) {
    throw new Error(
      `agent "${agentId}": sandbox.docker is not supported at the per-agent level. ` +
        `Move docker config to the agents-level (agents.defaults.sandbox.docker or top-level sandbox.docker); ` +
        `each agent may only override sandbox.mode and sandbox.workspaceAccess.`,
    );
  }

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
        ...(file.docker.pidsLimit !== undefined && { pidsLimit: file.docker.pidsLimit }),
        ...(file.docker.capDrop !== undefined && { capDrop: file.docker.capDrop }),
        ...(file.docker.capAdd !== undefined && { capAdd: file.docker.capAdd }),
        ...(file.docker.noNewPrivileges !== undefined && { noNewPrivileges: file.docker.noNewPrivileges }),
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

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
  // Sandbox: agents-level (defaults > global) is the base; per-agent overlays
  // partial overrides (typically just `mode: "off"`). The merge happens inside
  // resolveSandboxConfigFromFile so per-agent need not repeat docker config.
  const baseSandbox = agentDefaults?.sandbox ?? globalSandbox;

  const compaction = resolveCompactionConfigFromFile(agentCompaction);
  const sandbox =
    agent.sandbox || baseSandbox
      ? resolveSandboxConfigFromFile(agent.id, agent.sandbox, baseSandbox)
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
 * Get Discord token from a per-account config (literal token or env-var reference).
 */
export function getDiscordToken(account: DiscordAccountConfig): string {
  if (account.token) {
    return account.token;
  }
  if (account.tokenEnv) {
    const token = process.env[account.tokenEnv];
    if (!token) {
      throw new Error(`Environment variable ${account.tokenEnv} is not set`);
    }
    return token;
  }
  throw new Error("Discord account config must have either 'token' or 'tokenEnv'");
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
