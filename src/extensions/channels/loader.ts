// src/extensions/channels/loader.ts — Channel adapter loader.
//
// For v1 there is exactly one built-in adapter (Discord). The Discord
// adapter module may not exist yet (it lands in a sibling subtask); the
// loader logs a clear warning and continues rather than crashing.

import type { ChannelAdapter, ChannelAdapterDeps } from "../../channels/types.js";

export interface LoadChannelsResult {
  stopAll(): Promise<void>;
}

export interface LoadChannelsDeps extends ChannelAdapterDeps {
  config: { channels?: Record<string, unknown> };
}

export async function loadChannels(deps: LoadChannelsDeps): Promise<LoadChannelsResult> {
  const adapters: ChannelAdapter[] = [];

  if (deps.config.channels?.discord) {
    try {
      // Indirect specifier: the discord adapter module is added by a sibling
      // subtask. Until it lands, TypeScript would fail to resolve the path —
      // hide it behind a runtime variable so this file typechecks today and
      // wires up automatically once the module exists.
      const specifier = "../../channels/discord/index.js";
      const mod = (await import(/* @vite-ignore */ specifier)) as {
        createDiscordChannel: (config: unknown) => ChannelAdapter;
      };
      const adapter = mod.createDiscordChannel(deps.config.channels.discord);
      adapters.push(adapter);
    } catch (err) {
      deps.logger.warn(
        `channels.discord configured but discord adapter not loadable yet: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  await Promise.all(adapters.map((a) => a.start(deps)));

  return {
    stopAll: () => Promise.all(adapters.map((a) => a.stop())).then(() => {}),
  };
}
