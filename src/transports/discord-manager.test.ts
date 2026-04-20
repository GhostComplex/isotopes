// src/transports/discord-manager.test.ts — Unit tests for DiscordTransportManager

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiscordTransportManager } from "./discord-manager.js";
import { createMockAgentManager, createMockSessionStore } from "../core/test-helpers.js";

// ---------------------------------------------------------------------------
// Mock discord.js (same pattern as discord.test.ts)
// ---------------------------------------------------------------------------

let mockClientInstances: Array<{
  on: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  user: { id: string; tag: string };
}> = [];

vi.mock("discord.js", () => {
  return {
    Client: vi.fn(() => {
      const instance = {
        on: vi.fn(),
        login: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn(),
        user: { id: `bot-${mockClientInstances.length}`, tag: `Bot#${mockClientInstances.length}` },
      };
      mockClientInstances.push(instance);
      return instance;
    }),
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      DirectMessages: 4,
      MessageContent: 8,
    },
    Partials: {
      Channel: 1,
      Message: 2,
    },
  };
});

describe("DiscordTransportManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientInstances = [];
  });

  it("creates one transport per account and starts all", async () => {
    const agentManager = createMockAgentManager();
    const sessionStore = createMockSessionStore();

    const manager = new DiscordTransportManager({
      accounts: {
        major: { token: "tok-major", defaultAgentId: "major" },
        tachikoma: { token: "tok-tachikoma", defaultAgentId: "tachikoma" },
      },
      shared: { agentManager, sessionStore },
    });

    await manager.start();

    expect(manager.size).toBe(2);
    expect(manager.getTransport("major")).toBeDefined();
    expect(manager.getTransport("tachikoma")).toBeDefined();
    expect(manager.getTransport("nonexistent")).toBeUndefined();

    // Each transport should have logged in with its own token
    expect(mockClientInstances).toHaveLength(2);
    expect(mockClientInstances[0].login).toHaveBeenCalledWith("tok-major");
    expect(mockClientInstances[1].login).toHaveBeenCalledWith("tok-tachikoma");
  });

  it("stops all transports and clears the map", async () => {
    const agentManager = createMockAgentManager();
    const sessionStore = createMockSessionStore();

    const manager = new DiscordTransportManager({
      accounts: {
        bot1: { token: "tok-1" },
        bot2: { token: "tok-2" },
      },
      shared: { agentManager, sessionStore },
    });

    await manager.start();
    expect(manager.size).toBe(2);

    await manager.stop();
    expect(manager.size).toBe(0);

    // Both clients should have been destroyed
    expect(mockClientInstances[0].destroy).toHaveBeenCalled();
    expect(mockClientInstances[1].destroy).toHaveBeenCalled();
  });

  it("works with a single account (legacy normalized config)", async () => {
    const agentManager = createMockAgentManager();
    const sessionStore = createMockSessionStore();

    const manager = new DiscordTransportManager({
      accounts: {
        default: { token: "tok-legacy", defaultAgentId: "fairy" },
      },
      shared: { agentManager, sessionStore },
    });

    await manager.start();

    expect(manager.size).toBe(1);
    expect(manager.getTransport("default")).toBeDefined();
    expect(mockClientInstances[0].login).toHaveBeenCalledWith("tok-legacy");
  });

  it("passes account-specific config to each transport", async () => {
    const agentManager = createMockAgentManager();
    const sessionStore = createMockSessionStore();

    const manager = new DiscordTransportManager({
      accounts: {
        major: {
          token: "tok-major",
          defaultAgentId: "major",
          dm: { policy: "allowlist", allowlist: ["user-1"] },
          group: { policy: "allowlist", channelAllowlist: ["ch-1"] },
        },
        tachikoma: {
          token: "tok-tachi",
          defaultAgentId: "tachikoma",
          dm: { policy: "disabled" },
        },
      },
      shared: { agentManager, sessionStore },
    });

    await manager.start();

    const majorTransport = manager.getTransport("major")!;
    const tachiTransport = manager.getTransport("tachikoma")!;

    // Both transports should be separate instances
    expect(majorTransport).not.toBe(tachiTransport);

    // Each should have its own client
    expect(majorTransport.getClient()).not.toBe(tachiTransport.getClient());
  });

  it("getAll returns the full map", async () => {
    const agentManager = createMockAgentManager();
    const sessionStore = createMockSessionStore();

    const manager = new DiscordTransportManager({
      accounts: {
        a: { token: "tok-a" },
        b: { token: "tok-b" },
      },
      shared: { agentManager, sessionStore },
    });

    await manager.start();

    const all = manager.getAll();
    expect(all.size).toBe(2);
    expect(all.has("a")).toBe(true);
    expect(all.has("b")).toBe(true);
  });
});
