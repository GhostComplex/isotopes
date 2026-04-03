// src/index.ts — Main entry point for Isotopes

export const VERSION = '0.1.0';

// Re-export core modules
export * from './core/index.js';
export * from './orchestrator/index.js';
export * from './transports/index.js';
export { loadConfig, resolveProvider, ConfigSchema, substituteEnvVars, type AppConfig } from './config/index.js';

// --- CLI entry (run with `npm run dev`) ---

import { loadConfig, resolveProvider } from './config/index.js';
import { OpenAIAgentsCore } from './core/index.js';
import { JsonAgentManager, JsonlSessionStore } from './orchestrator/index.js';
import { DiscordTransport } from './transports/index.js';
import * as path from 'node:path';

async function main() {
  const configPath = process.env.ISOTOPES_CONFIG ?? 'config.yaml';
  console.log(`[isotopes] Loading config from ${configPath}`);

  const config = await loadConfig(configPath);
  const provider = resolveProvider(config);

  // Create core
  const core = new OpenAIAgentsCore({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
  });

  // Create agent manager
  const dataDir = path.resolve(config.storage.dataDir);
  const agentManager = new JsonAgentManager(core, dataDir);
  await agentManager.init();

  // Create session store
  const sessionStore = new JsonlSessionStore({
    dataDir,
    maxSessions: config.storage.maxSessions,
    maxTotalSizeMB: config.storage.maxTotalSizeMB,
  });

  // Start Discord transport
  const discord = new DiscordTransport(
    {
      token: config.discord.token,
      channelAgentMap: config.discord.channelAgentMap,
    },
    agentManager,
    sessionStore,
  );

  await discord.start();
  console.log(`[isotopes] v${VERSION} started`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[isotopes] Shutting down...');
    await discord.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only run main() when executed directly (not imported)
const isDirectRun = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isDirectRun) {
  main().catch((err) => {
    console.error('[isotopes] Fatal error:', err);
    process.exit(1);
  });
}
