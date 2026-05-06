// src/config.ts — Configuration loading for Isotopes
// Loads agent and runtime configuration from YAML/JSON files.

import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { ProviderType } from "./agent/types.js";
import type {
  AgentConfig,
} from "./agent/types.js";
import type { AgentToolSettings } from "./agent/tools/types.js";
import type { ChannelsConfig } from "./gateway/types.js";
import type { CronActionConfig } from "./automation/types.js";
import { resolveSandboxConfig, type SandboxConfig } from "./sandbox/config.js";
import type { PluginConfigEntry } from "./legacy/plugins/types.js";


// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

export interface ProviderConfigFile {
  type: ProviderType;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
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
  /** Runner backend. Default "pi". */
  runner?: "pi" | "claude";
  /** Default true. */
  enabled?: boolean;
  /** Absolute or ISOTOPES_HOME-relative. Omitted → workspace-{id}/. */
  workspace?: string;
  tools?: AgentToolsConfigFile;
  model?: string;
  sandbox?: SandboxConfigFile;
  heartbeat?: HeartbeatConfigFile;
  cron?: { tasks: CronTaskConfigFile[] };
  /** Default false. */
  spawnable?: boolean;
  /** "parent-reuse" (default) | "always-new". */
  sessionPolicy?: "always-new" | "parent-reuse";
}

export interface AgentToolsConfigFile {
  /** Tool names to explicitly allow (if set, only these are available) */
  allow?: string[];
  /** Tool names to explicitly deny (takes precedence over allow) */
  deny?: string[];
}

export interface SandboxDockerConfigFile {
  image?: string;
  network?: string;
  extraHosts?: string[];
  cpuLimit?: number;
  memoryLimit?: string;
  pidsLimit?: number;
  noNewPrivileges?: boolean;
}

export interface SandboxMountConfigFile {
  host: string;
  container: string;
  readOnly?: boolean;
}

export interface SandboxConfigFile {
  enabled?: boolean;
  workspaceAccess?: string;
  mounts?: SandboxMountConfigFile[];
  docker?: SandboxDockerConfigFile;
}

// SessionConfig from core/types.ts is used directly — no separate config-file type needed
// since the config-file shape is identical to the runtime type.

/** Context management configuration (shared across transports) */
export interface ContextConfigFile {
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
}

/** Cron job configuration in config file */
export interface CronJobConfigFile {
  name: string;
  expression: string;
  agentId: string;
  action: CronActionConfig;
  enabled?: boolean;
}

export interface IsotopesConfigFile {
  /** Default provider for all agents */
  provider?: ProviderConfigFile;
  /** Default tool policy/guards for all agents */
  tools?: AgentToolsConfigFile;
  /** Default sandbox config for all agents */
  sandbox?: SandboxConfigFile;
  /** Agent definitions */
  agents: AgentConfigFile[];
  /** Channel configurations (Discord accounts, per-guild settings) */
  channels?: ChannelsConfig;
  /** Channel-level cron job definitions */
  cron?: CronJobConfigFile[];
  /** Plugin configurations */
  plugins?: Record<string, PluginConfigEntry>;
}

export function resolveToolSettings(
  agentTools?: AgentToolsConfigFile,
  defaultTools?: AgentToolsConfigFile,
): AgentToolSettings {
  return {
    // allow/deny: agent-level overrides defaults entirely (not merged)
    allow: agentTools?.allow ?? defaultTools?.allow,
    deny: agentTools?.deny ?? defaultTools?.deny,
  };
}

/**
 * Resolve sandbox config from config file types.
 *
 * Layered resolution: top-level `sandbox` provides image / docker /
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

  const defaults = defaultSandbox
    ? toSandboxConfig(defaultSandbox)
    : undefined;
  const override = agentSandbox
    ? toSandboxConfig(agentSandbox)
    : undefined;

  return resolveSandboxConfig(agentId, defaults, override);
}

function toSandboxConfig(file: SandboxConfigFile): SandboxConfig {
  return {
    enabled: file.enabled ?? false,
    ...(file.workspaceAccess !== undefined && {
      workspaceAccess: file.workspaceAccess as SandboxConfig["workspaceAccess"],
    }),
    ...(file.mounts && {
      mounts: file.mounts.map((m) => ({
        host: m.host,
        container: m.container,
        ...(m.readOnly !== undefined && { readOnly: m.readOnly }),
      })),
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

  let raw: IsotopesConfigFile;

  if (ext === ".yaml" || ext === ".yml") {
    raw = YAML.parse(content) as IsotopesConfigFile;
  } else if (ext === ".json") {
    raw = JSON.parse(content) as IsotopesConfigFile;
  } else {
    // Try YAML first, then JSON
    try {
      raw = YAML.parse(content) as IsotopesConfigFile;
    } catch {
      raw = JSON.parse(content) as IsotopesConfigFile;
    }
  }

  if (!Array.isArray(raw.agents)) {
    throw new Error("Config must have an 'agents' array");
  }
  if (raw.agents.length === 0) {
    throw new Error("Config must have at least one agent");
  }

  // Process environment variables
  return processEnvVars(raw);
}

/**
 * Convert config file agent to AgentConfig.
 * Merge priority: agent > global
 */
export function toAgentConfig(
  agent: AgentConfigFile,
  globalProvider?: ProviderConfigFile,
  globalTools?: AgentToolsConfigFile,
  globalSandbox?: SandboxConfigFile,
): AgentConfig {
  // 2-tier merge: agent > global (shallow replace per block)
  const tools = agent.tools ?? globalTools;
  const resolvedToolSettings = resolveToolSettings(tools);
  // Sandbox: top-level provides docker / workspaceAccess; per-agent overlays
  // partial overrides (typically just `enabled: false`). The merge happens
  // inside resolveSandboxConfigFromFile so per-agent need not repeat docker config.

  // Model: per-agent override > global defaultModel
  const model = agent.model ?? globalProvider?.defaultModel;

  const sandbox =
    agent.sandbox || globalSandbox
      ? resolveSandboxConfigFromFile(agent.id, agent.sandbox, globalSandbox)
      : undefined;

  return {
    id: agent.id,
    runner: agent.runner ?? "pi",
    ...(agent.workspace ? { workspace: agent.workspace } : {}),
    toolSettings: resolvedToolSettings,
    ...(model ? { model } : {}),
    sandbox,
    spawnable: agent.spawnable,
    sessionPolicy: agent.sessionPolicy,
  };
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
