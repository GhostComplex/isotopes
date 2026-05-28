// src/extensions/channels/loader.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Gateway } from "../../gateway/index.js";
import type { Channel } from "../../channels/types.js";
import { startChannels } from "./loader.js";

const fakeGateway = {} as Gateway;

describe("startChannels", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../../channels/discord/index.js");
  });

  it("loads no adapters when channels.discord config is absent", async () => {
    const result = await startChannels({
      gateway: fakeGateway,
      config: {},
    });
    await expect(result.stopAll()).resolves.toBeUndefined();
  });

  it("loads the discord adapter when channels.discord is configured (no-accounts no-op)", async () => {
    const result = await startChannels({
      gateway: fakeGateway,
      config: { channels: { discord: { token: "x" } } },
    });
    await expect(result.stopAll()).resolves.toBeUndefined();
  });

  it("starts the discord adapter when the import succeeds", async () => {
    const start = vi.fn<Channel["start"]>(async () => {});
    const stop = vi.fn<Channel["stop"]>(async () => {});
    const adapter: Channel = { start, stop };
    const createDiscordChannel = vi.fn(() => adapter);

    vi.doMock("../../channels/discord/index.js", () => ({ createDiscordChannel }));

    const { startChannels: load } = await import("./loader.js");

    const discordCfg = { token: "abc" };
    const result = await load({
      gateway: fakeGateway,
      config: { channels: { discord: discordCfg } },
    });

    expect(createDiscordChannel).toHaveBeenCalledWith(discordCfg);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0]).toMatchObject({ gateway: fakeGateway });

    await result.stopAll();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
