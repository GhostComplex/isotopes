import type { Transport } from "../../../gateway/types.js";
import type { SessionStore } from "../../../sessions/types.js";
import type { LazyTransportContext } from "../../../gateway/transport-context.js";
import type { SessionStoreManager } from "../../../agents/runners/pi/session-store.js";
import type { AgentRuntime } from "../../../agents/runtime.js";
import type { IsotopesConfigFile } from "../../../config.js";
import { DiscordTransportManager } from "./discord-manager.js";
import { ThreadBindingManager } from "./thread-bindings.js";
import type { DiscordChannelsConfig } from "./types.js";
import { createLogger } from "../../../logging/logger.js";
import path from "node:path";

const log = createLogger("transport:discord");

export interface CreateDiscordTransportOptions {
  config: IsotopesConfigFile;
  sessionStoreManager: SessionStoreManager;
  agentRuntime: AgentRuntime;
  transportContexts: Map<string, LazyTransportContext>;
  isotopesHome: string;
}

export async function createDiscordTransport(opts: CreateDiscordTransportOptions): Promise<Transport> {
  const { config, sessionStoreManager, agentRuntime, transportContexts, isotopesHome } = opts;
  const discordConfig = config.channels?.discord as DiscordChannelsConfig | undefined;
  const accounts = discordConfig?.accounts ?? {};

  if (Object.keys(accounts).length === 0) {
    log.warn("channels.discord present but no accounts configured — transport is a no-op");
    return { start: async () => {}, stop: async () => {} };
  }

  const sessionStores = new Map<string, SessionStore>();
  for (const agentFile of config.agents) {
    sessionStores.set(agentFile.id, await sessionStoreManager.getOrCreate(agentFile.id));
  }

  const firstAccount = Object.values(accounts)[0];
  const defaultAgentId = firstAccount?.defaultAgentId || config.agents[0]?.id;
  const defaultSessionStore =
    sessionStores.get(defaultAgentId) ?? (await sessionStoreManager.getOrCreate(defaultAgentId));

  const threadBindingsPath = path.join(isotopesHome, "thread-bindings.json");
  const threadBindingManager = new ThreadBindingManager({ persistPath: threadBindingsPath });
  await threadBindingManager.load({ clearStale: true });
  if (threadBindingManager.size > 0) {
    log.info(`Loaded ${threadBindingManager.size} persisted thread binding(s)`);
  }

  const discordManager = new DiscordTransportManager({
    accounts,
    shared: {
      agentRuntime,
      sessionStore: defaultSessionStore,
      sessionStoreForAgent: (agentId) =>
        sessionStoreManager.peek(agentId) ?? sessionStores.get(agentId) ?? defaultSessionStore,
      threadBindingManager,
    },
  });

  const anyThreadBindings = Object.values(accounts).some((a) => a.threadBindings?.enabled);
  if (anyThreadBindings) {
    log.info("Discord thread bindings enabled");
  }

  return {
    async start() {
      await discordManager.start();
      log.info(`Discord transport started (${discordManager.size} account(s))`);

      const firstTransport = discordManager.getAll().values().next().value;
      if (firstTransport) {
        for (const [agentId, transportCtx] of transportContexts) {
          transportCtx.setTransport(firstTransport);
          log.debug(`Bound Discord transport for react tools (agent: ${agentId})`);
        }
      }
    },

    async stop() {
      await discordManager.stop();
    },
  };
}
