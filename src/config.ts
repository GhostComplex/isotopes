import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { ProviderType, AgentConfig } from "./agent/types.js";
import type { AgentToolSettings } from "./agent/tools/types.js";
import type { ChannelsConfig } from "./legacy/gateway/types.js";
import type { CronActionConfig } from "./automation/types.js";
import { resolveSandboxConfig, type SandboxConfig } from "./agent/middleware/sandbox-config.js";

export interface ProviderConfigFile {
  type: ProviderType;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
}

export interface HeartbeatConfigFile {
  enabled?: boolean;
  /** Default: 300 (5 min) */
  intervalSeconds?: number;
}

export interface CronTaskConfigFile {
  name: string;
  /** Cron expression, e.g. "0 * * * *" */
  schedule: string;
  channel: string;
  prompt: string;
  /** Default: true */
  enabled?: boolean;
}

export interface AgentConfigFile {
  id: string;
  /** Default: "pi" */
  runner?: "pi" | "claude";
  /** Default: true */
  enabled?: boolean;
  /** Absolute or ISOTOPES_HOME-relative. Default: workspace-{id}/. */
  workspace?: string;
  tools?: AgentToolsConfigFile;
  model?: string;
  sandbox?: SandboxConfigFile;
  heartbeat?: HeartbeatConfigFile;
  cron?: { tasks: CronTaskConfigFile[] };
  /** Default: false */
  spawnable?: boolean;
  /** Default: "parent-reuse" */
  sessionPolicy?: "always-new" | "parent-reuse";
}

export interface AgentToolsConfigFile {
  /** If non-empty, only these tools are exposed. */
  allow?: string[];
  /** Always blocked. Wins over allow. */
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

export interface ContextConfigFile {
  /** Default: true */
  channelHistory?: boolean;
  /** Default: 20 */
  channelHistoryLimit?: number;
  /** Default: true */
  dedupe?: boolean;
  /** Default: false */
  debounce?: boolean;
  /** Default: 1500 */
  debounceWindowMs?: number;
}

export interface CronJobConfigFile {
  name: string;
  expression: string;
  agentId: string;
  action: CronActionConfig;
  enabled?: boolean;
}

export interface IsotopesConfigFile {
  provider?: ProviderConfigFile;
  tools?: AgentToolsConfigFile;
  sandbox?: SandboxConfigFile;
  agents: AgentConfigFile[];
  channels?: ChannelsConfig;
  cron?: CronJobConfigFile[];
}

export function resolveToolSettings(
  agentTools?: AgentToolsConfigFile,
  defaultTools?: AgentToolsConfigFile,
): AgentToolSettings {
  // Agent overrides defaults entirely (not merged) per allow/deny block.
  return {
    allow: agentTools?.allow ?? defaultTools?.allow,
    deny: agentTools?.deny ?? defaultTools?.deny,
  };
}

// Per-agent sandbox is a partial overlay (e.g. just `enabled: false`); docker
// settings only come from the top-level config because the runtime maintains a
// single global ContainerManager.
export function resolveSandboxConfigFromFile(
  agentId: string,
  agentSandbox?: SandboxConfigFile,
  defaultSandbox?: SandboxConfigFile,
): SandboxConfig | undefined {
  if (!agentSandbox && !defaultSandbox) return undefined;

  const defaults = defaultSandbox ? toSandboxConfig(defaultSandbox) : undefined;
  const override = agentSandbox ? toSandboxConfig(agentSandbox) : undefined;

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

export async function loadConfig(filePath: string): Promise<IsotopesConfigFile> {
  const content = await fs.readFile(filePath, "utf-8");
  const ext = path.extname(filePath).toLowerCase();

  let raw: IsotopesConfigFile;

  if (ext === ".yaml" || ext === ".yml") {
    raw = YAML.parse(content) as IsotopesConfigFile;
  } else if (ext === ".json") {
    raw = JSON.parse(content) as IsotopesConfigFile;
  } else {
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

  return processEnvVars(raw);
}

export function toAgentConfig(
  agent: AgentConfigFile,
  globalProvider?: ProviderConfigFile,
  globalTools?: AgentToolsConfigFile,
  globalSandbox?: SandboxConfigFile,
): AgentConfig {
  const resolvedToolSettings = resolveToolSettings(agent.tools ?? globalTools);
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

// Recursively substitute ${VAR} and ${VAR:-default} in string values.
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

function substituteEnvVars(str: string): string {
  return str.replace(/\$\{([^}]+)\}/g, (match, expr: string) => {
    const [varName, defaultValue] = expr.split(":-");
    const value = process.env[varName.trim()];

    if (value !== undefined) return value;
    if (defaultValue !== undefined) return defaultValue;
    // Unset vars without default — leave the literal `${VAR}` so it's visible.
    return match;
  });
}
