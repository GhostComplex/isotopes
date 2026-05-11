// src/extensions/channels/loader.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Gateway } from "../../gateway/index.js";
import type { Logger } from "../../logging/logger.js";
import type { Channel } from "../../channels/types.js";
import { loadChannels } from "./loader.js";

function makeLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg: string) => { warnings.push(msg); },
    error: () => {},
    child: () => log,
  };
  return Object.assign(log, { warnings });
}

const fakeGateway = {} as Gateway;

describe("loadChannels", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../../channels/discord/index.js");
  });

  it("loads no adapters when channels.discord config is absent", async () => {
    const logger = makeLogger();
    const result = await loadChannels({
      gateway: fakeGateway,
      config: {},
      logger,
    });
    expect(logger.warnings).toHaveLength(0);
    await expect(result.stopAll()).resolves.toBeUndefined();
  });

  it("loads the discord adapter when channels.discord is configured (no-accounts no-op)", async () => {
    // The real adapter module now exists. With no accounts in config, it
    // starts as a no-op and logs the "no accounts configured" warning.
    const logger = makeLogger();
    const result = await loadChannels({
      gateway: fakeGateway,
      config: { channels: { discord: { token: "x" } } },
      logger,
    });
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toMatch(/no accounts configured/);
    await expect(result.stopAll()).resolves.toBeUndefined();
  });

  it("starts the discord adapter when the import succeeds", async () => {
    const start = vi.fn<Channel["start"]>(async () => {});
    const stop = vi.fn<Channel["stop"]>(async () => {});
    const adapter: Channel = { start, stop };
    const createDiscordChannel = vi.fn(() => adapter);

    vi.doMock("../../channels/discord/index.js", () => ({ createDiscordChannel }));

    // Re-import after mocking so the dynamic import inside loader resolves.
    const { loadChannels: load } = await import("./loader.js");

    const logger = makeLogger();
    const discordCfg = { token: "abc" };
    const result = await load({
      gateway: fakeGateway,
      config: { channels: { discord: discordCfg } },
      logger,
    });

    expect(createDiscordChannel).toHaveBeenCalledWith(discordCfg);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0]).toMatchObject({ gateway: fakeGateway, logger });
    expect(logger.warnings).toHaveLength(0);

    await result.stopAll();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
