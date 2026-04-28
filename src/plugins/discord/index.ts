// plugins/discord/index.ts — Discord transport plugin for Isotopes
// Registers the Discord transport via the plugin system.

import type { IsotopesPluginApi, TransportFactoryContext } from "../types.js";
import type { Transport, SessionStore } from "../../core/types.js";
import { DiscordTransportManager } from "./discord-manager.js";
import { ThreadBindingManager } from "./thread-bindings.js";
import type { DiscordChannelsConfig } from "./types.js";
import { createLogger } from "../../core/logger.js";
import path from "node:path";

const log = createLogger("plugin:discord");

export default {
  register(api: IsotopesPluginApi) {
    api.registerTransport("discord", async (ctx: TransportFactoryContext): Promise<Transport> => {
      const discordConfig = ctx.config.channels?.discord as DiscordChannelsConfig | undefined;
      const accounts = discordConfig?.accounts ?? {};

      if (Object.keys(accounts).length === 0) {
        log.warn("channels.discord present but no accounts configured — transport is a no-op");
        return { start: async () => {}, stop: async () => {} };
      }

      const sessionStores = new Map<string, SessionStore>();
      for (const agentFile of ctx.config.agents) {
        sessionStores.set(agentFile.id, await ctx.sessionStoreManager.getOrCreate(agentFile.id));
      }

      const firstAccount = Object.values(accounts)[0];
      const defaultAgentId = firstAccount?.defaultAgentId || ctx.config.agents[0]?.id;
      const defaultSessionStore =
        sessionStores.get(defaultAgentId) ?? (await ctx.sessionStoreManager.getOrCreate(defaultAgentId));

      const threadBindingsPath = path.join(ctx.isotopesHome, "thread-bindings.json");
      const threadBindingManager = new ThreadBindingManager({ persistPath: threadBindingsPath });
      await threadBindingManager.load({ clearStale: true });
      if (threadBindingManager.size > 0) {
        log.info(`Loaded ${threadBindingManager.size} persisted thread binding(s)`);
      }

      const discordManager = new DiscordTransportManager({
        accounts,
        shared: {
          agentManager: ctx.agentManager,
          agentRuntime: ctx.agentRuntime,
          sessionStore: defaultSessionStore,
          sessionStoreForAgent: (agentId) =>
            ctx.getSessionStoreForAgent(agentId) ?? sessionStores.get(agentId) ?? defaultSessionStore,
          threadBindingManager,
          usageTracker: ctx.usageTracker,
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
            for (const [agentId, transportCtx] of ctx.transportContexts) {
              transportCtx.setTransport(firstTransport);
              log.debug(`Bound Discord transport for react tools (agent: ${agentId})`);
            }
          }
        },

        async stop() {
          await discordManager.stop();
        },
      };
    });
  },
};
