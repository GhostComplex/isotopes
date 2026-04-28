// src/transport/session-key-codec.test.ts

import { describe, it, expect } from "vitest";
import { composeSessionId, parseSessionId } from "./session-key-codec.js";

describe("composeSessionId", () => {
  it("joins parts with colons", () => {
    expect(composeSessionId({ transport: "discord", channel: "1234", agentId: "main" }))
      .toBe("discord:1234:main");
  });

  it("rejects empty parts", () => {
    expect(() => composeSessionId({ transport: "", channel: "c", agentId: "a" })).toThrow();
    expect(() => composeSessionId({ transport: "t", channel: "", agentId: "a" })).toThrow();
    expect(() => composeSessionId({ transport: "t", channel: "c", agentId: "" })).toThrow();
  });

  it("rejects colons in transport or channel", () => {
    expect(() => composeSessionId({ transport: "a:b", channel: "c", agentId: "x" })).toThrow();
    expect(() => composeSessionId({ transport: "t", channel: "a:b", agentId: "x" })).toThrow();
  });

  it("allows colons in agentId (takes everything after second colon)", () => {
    const id = composeSessionId({ transport: "t", channel: "c", agentId: "a:b:c" });
    expect(id).toBe("t:c:a:b:c");
    expect(parseSessionId(id)).toEqual({ transport: "t", channel: "c", agentId: "a:b:c" });
  });
});

describe("parseSessionId", () => {
  it("parses a well-formed id", () => {
    expect(parseSessionId("discord:1234:main"))
      .toEqual({ transport: "discord", channel: "1234", agentId: "main" });
  });

  it("returns undefined for malformed ids", () => {
    expect(parseSessionId("nocolons")).toBeUndefined();
    expect(parseSessionId("only:one")).toBeUndefined();
    expect(parseSessionId(":empty:agent")).toBeUndefined();
    expect(parseSessionId("t::a")).toBeUndefined();
    expect(parseSessionId("t:c:")).toBeUndefined();
  });

  it("round-trips composed ids", () => {
    const parts = { transport: "tui", channel: "cli", agentId: "bot" };
    expect(parseSessionId(composeSessionId(parts))).toEqual(parts);
  });
});
