// src/core/config.ts — Configuration loading for Isotopes
// Loads agent and runtime configuration from YAML/JSON files.

import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { AgentConfig, AgentToolSettings, ProviderConfig } from "./types.js";

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
}

export interface AgentToolsConfigFile {
  cli?: boolean;
  fs?: {
    workspaceOnly?: boolean;
  };
}

/** Discord transport configuration */
export interface DiscordConfigFile {
  token?: string;
  tokenEnv?: string;
  defaultAgentId?: string;
  agentBindings?: Record<string, string>;
  allowDMs?: boolean;
  channelAllowlist?: string[];
}

/** Root configuration file structure */
export interface IsotopesConfigFile {
  /** Default provider for all agents */
  provider?: ProviderConfigFile;
  /** Default tool policy/guards for all agents */
  tools?: AgentToolsConfigFile;
  /** Agent definitions */
  agents: AgentConfigFile[];
  /** Discord transport config */
  discord?: DiscordConfigFile;
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
): AgentConfig {
  return {
    id: agent.id,
    name: agent.name,
    systemPrompt: agent.systemPrompt ?? "",
    workspacePath: agent.workspacePath,
    toolSettings: resolveToolSettings(agent.tools, defaultTools),
    provider: (agent.provider ?? defaultProvider) as ProviderConfig | undefined,
  };
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
