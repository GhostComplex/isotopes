// src/config/index.ts — YAML config loader with Zod validation + env var substitution

import * as fs from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// --- Zod schemas ---

const ProviderSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
});

const ProvidersSchema = z.object({
  'openai-proxy': ProviderSchema.optional(),
  'anthropic-proxy': ProviderSchema.optional(),
  openai: ProviderSchema.optional(),
  anthropic: ProviderSchema.optional(),
}).optional();

const DiscordSchema = z.object({
  token: z.string(),
  channelAgentMap: z.record(z.string()).optional(),
});

const StorageSchema = z.object({
  dataDir: z.string().default('./data'),
  maxSessions: z.number().default(100),
  maxTotalSizeMB: z.number().default(100),
}).default({});

export const ConfigSchema = z.object({
  providers: ProvidersSchema,
  defaultProvider: z.string().default('openai-proxy'),
  defaultModel: z.string().default('gpt-4o'),
  discord: DiscordSchema,
  storage: StorageSchema,
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/**
 * Substitute environment variables in the format ${VAR_NAME}.
 * Returns the string with all ${...} replaced by their env values.
 * Missing vars are replaced with empty string.
 */
export function substituteEnvVars(raw: string): string {
  return raw.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    return process.env[varName] ?? '';
  });
}

/**
 * Load and validate config from a YAML file path.
 */
export async function loadConfig(filePath: string): Promise<AppConfig> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const substituted = substituteEnvVars(raw);
  const parsed = parseYaml(substituted);
  return ConfigSchema.parse(parsed);
}

/**
 * Resolve the provider base URL and API key from config for a given provider name.
 */
export function resolveProvider(config: AppConfig, providerName?: string) {
  const name = providerName ?? config.defaultProvider;
  const providerConf = config.providers?.[name as keyof NonNullable<typeof config.providers>];

  return {
    baseUrl: providerConf?.baseUrl,
    apiKey: providerConf?.apiKey,
    model: config.defaultModel,
  };
}
