// src/gateway/session-keys.test.ts — Unit tests for the shared session key builder

import { describe, it, expect } from "vitest";
import { buildSessionKey } from "./session-keys.js";

describe("buildSessionKey", () => {
  it("builds a colon-delimited key", () => {
    expect(buildSessionKey("discord", "bot-1", "channel", "ch-1")).toBe(
      "discord:bot-1:channel:ch-1",
    );
  });

  it("supports dm scope", () => {
    expect(buildSessionKey("discord", "bot-1", "dm", "user-1")).toBe(
      "discord:bot-1:dm:user-1",
    );
  });

  it("supports thread scope", () => {
    expect(buildSessionKey("discord", "bot-1", "thread", "thread-1")).toBe(
      "discord:bot-1:thread:thread-1",
    );
  });

  it("supports group scope", () => {
    expect(buildSessionKey("feishu", "app-1", "group", "group-1")).toBe(
      "feishu:app-1:group:group-1",
    );
  });

  it("produces unique keys for different transports", () => {
    const k1 = buildSessionKey("discord", "id", "dm", "u1");
    const k2 = buildSessionKey("feishu", "id", "dm", "u1");
    expect(k1).not.toBe(k2);
  });

  it("produces unique keys for different scopes", () => {
    const k1 = buildSessionKey("discord", "b1", "channel", "x");
    const k2 = buildSessionKey("discord", "b1", "dm", "x");
    expect(k1).not.toBe(k2);
  });

  it("produces same key for different agents — agentId is not part of the key", () => {
    // (agentId, sessionKey) pair is the unique identifier; agentId namespacing
    // happens at the per-agent SessionStore layer, not in the key string.
    const k1 = buildSessionKey("discord", "b1", "channel", "ch1");
    const k2 = buildSessionKey("discord", "b1", "channel", "ch1");
    expect(k1).toBe(k2);
  });
});
