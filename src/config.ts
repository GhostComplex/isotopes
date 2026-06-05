import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { ProviderType, AgentConfig } from "./agent/types.js";
import type { AgentToolSettings } from "./agent/tools/types.js";
import type { ChannelsConfig } from "./channels/types.js";
import type { CronAction, CronChannelConfig } from "./automation/types.js";

export interface ProviderConfigFile {
  type: ProviderType;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
}

export interface HeartbeatConfigFile {
  enabled?: boolean;
  intervalSeconds?: number;
}

export interface AgentConfigFile {
  id: string;
  runner?: "pi" | "claude";
  enabled?: boolean;
  /** Absolute or ISOTOPES_HOME-relative. */
  workspace?: string;
  tools?: AgentToolsConfigFile;
  model?: string;
  heartbeat?: HeartbeatConfigFile;
  spawnable?: boolean;
  sessionPolicy?: "always-new" | "parent-reuse";
}

export interface AgentToolsConfigFile {
  /** If non-empty, only these tools are exposed. */
  allow?: string[];
  /** Always blocked. Wins over allow. */
  deny?: string[];
}

export interface CronJobConfigFile {
  name: string;
  expression: string;
  agentId: string;
  action: CronAction;
  enabled?: boolean;
  channel?: CronChannelConfig;
}

export interface IsotopesConfigFile {
  provider?: ProviderConfigFile;
  tools?: AgentToolsConfigFile;
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

  const agentIdPattern = /^[a-z0-9_-]+$/;
  for (const agent of raw.agents) {
    if (!agentIdPattern.test(agent.id)) {
      throw new Error(
        `Invalid agent id "${agent.id}": must match [a-z0-9_-]+`,
      );
    }
  }

  normalizeScheduledChannels(raw);

  return processEnvVars(raw);
}

const DEFAULT_READ_LAST = 25;

function normalizeScheduledChannels(raw: IsotopesConfigFile): void {
  for (const t of raw.cron ?? []) {
    if (t.channel && t.channel.readLast === undefined) {
      t.channel.readLast = DEFAULT_READ_LAST;
    }
  }
}

export function toAgentConfig(
  agent: AgentConfigFile,
  globalProvider?: ProviderConfigFile,
  globalTools?: AgentToolsConfigFile,
): AgentConfig {
  const resolvedToolSettings = resolveToolSettings(agent.tools ?? globalTools);
  const model = agent.model ?? globalProvider?.defaultModel;

  return {
    id: agent.id,
    runner: agent.runner ?? "pi",
    ...(agent.workspace ? { workspace: agent.workspace } : {}),
    toolSettings: resolvedToolSettings,
    ...(model ? { model } : {}),
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
