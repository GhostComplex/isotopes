import { describe, it, expect, vi, afterEach } from "vitest";
import { getDiscordToken } from "./config.js";
import type { DiscordAccountConfig } from "../../channels/discord/types.js";

describe("getDiscordToken", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns token when provided directly", () => {
    const account: DiscordAccountConfig = { token: "direct-token" };
    expect(getDiscordToken(account)).toBe("direct-token");
  });

  it("returns token from env var when tokenEnv is set", () => {
    vi.stubEnv("MY_DISCORD_TOKEN", "env-token");
    const account: DiscordAccountConfig = { tokenEnv: "MY_DISCORD_TOKEN" };
    expect(getDiscordToken(account)).toBe("env-token");
  });

  it("throws when tokenEnv references an unset variable", () => {
    const account: DiscordAccountConfig = { tokenEnv: "MISSING_VAR" };
    expect(() => getDiscordToken(account)).toThrow("MISSING_VAR is not set");
  });

  it("throws when neither token nor tokenEnv is provided", () => {
    const account: DiscordAccountConfig = {};
    expect(() => getDiscordToken(account)).toThrow("must have either");
  });

  it("prefers token over tokenEnv when both are provided", () => {
    vi.stubEnv("MY_TOKEN", "env-value");
    const account: DiscordAccountConfig = { token: "direct", tokenEnv: "MY_TOKEN" };
    expect(getDiscordToken(account)).toBe("direct");
  });
});
