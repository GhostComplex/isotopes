import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Gateway } from "../../gateway/index.js";
import type { Channel } from "../../channels/types.js";
import { ChannelManager } from "./loader.js";

const fakeGateway = {} as Gateway;

describe("ChannelManager", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../../channels/discord/index.js");
  });

  it("loads no adapters when channels.discord config is absent", async () => {
    const manager = new ChannelManager({});
    await manager.start({ gateway: fakeGateway });
    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it("loads the discord adapter when channels.discord is configured (no-accounts no-op)", async () => {
    const manager = new ChannelManager({ channels: { discord: { token: "x" } } });
    await manager.start({ gateway: fakeGateway });
    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it("starts the discord adapter when the import succeeds", async () => {
    const start = vi.fn<Channel["start"]>(async () => {});
    const stop = vi.fn<Channel["stop"]>(async () => {});
    const adapter: Channel = { start, stop };
    const createDiscordChannel = vi.fn(() => adapter);

    vi.doMock("../../channels/discord/index.js", () => ({ createDiscordChannel }));

    const { ChannelManager: CM } = await import("./loader.js");

    const discordCfg = { token: "abc" };
    const manager = new CM({ channels: { discord: discordCfg } });
    await manager.start({ gateway: fakeGateway });

    expect(createDiscordChannel).toHaveBeenCalledWith(discordCfg);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0]).toMatchObject({ gateway: fakeGateway });

    await manager.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
