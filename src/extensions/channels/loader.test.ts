// src/extensions/channels/loader.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Gateway } from "../../gateway/index.js";
import type { Logger } from "../../logging/logger.js";
import type { ChannelAdapter } from "../../channels/types.js";
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

  it("logs a warning and does not throw when discord adapter import fails", async () => {
    // No mock registered — the import will fail because the file does not exist.
    const logger = makeLogger();
    const result = await loadChannels({
      gateway: fakeGateway,
      config: { channels: { discord: { token: "x" } } },
      logger,
    });
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toMatch(/discord adapter not loadable/);
    await expect(result.stopAll()).resolves.toBeUndefined();
  });

  it("starts the discord adapter when the import succeeds", async () => {
    const start = vi.fn<ChannelAdapter["start"]>(async () => {});
    const stop = vi.fn<ChannelAdapter["stop"]>(async () => {});
    const adapter: ChannelAdapter = { start, stop };
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
