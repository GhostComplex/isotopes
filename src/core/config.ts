// src/core/config.ts — Configuration loading for Isotopes
// Loads agent and runtime configuration from YAML/JSON files.

import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { AgentConfig, ProviderConfig } from "./types.js";

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
  provider?: ProviderConfigFile;
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
  /** Agent definitions */
  agents: AgentConfigFile[];
  /** Discord transport config */
  discord?: DiscordConfigFile;
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
): AgentConfig {
  return {
    id: agent.id,
    name: agent.name,
    systemPrompt: agent.systemPrompt ?? "",
    workspacePath: agent.workspacePath,
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

// ---------------------------------------------------------------------------
// Config discovery
// ---------------------------------------------------------------------------

/** Default config file names to search for */
const CONFIG_FILENAMES = [
  "isotopes.yaml",
  "isotopes.yml",
  "isotopes.json",
  ".isotopes.yaml",
  ".isotopes.yml",
  ".isotopes.json",
];

/**
 * Find config file in directory.
 * Searches for known config filenames.
 */
export async function findConfigFile(dir: string): Promise<string | null> {
  for (const filename of CONFIG_FILENAMES) {
    const filePath = path.join(dir, filename);
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // File doesn't exist, try next
    }
  }
  return null;
}

/**
 * Load config from directory, searching for known filenames.
 */
export async function loadConfigFromDir(dir: string): Promise<IsotopesConfigFile> {
  const filePath = await findConfigFile(dir);
  if (!filePath) {
    throw new Error(
      `No config file found in ${dir}. Expected one of: ${CONFIG_FILENAMES.join(", ")}`,
    );
  }
  return loadConfig(filePath);
}
