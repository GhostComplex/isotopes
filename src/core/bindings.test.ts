// src/core/bindings.test.ts — Unit tests for binding resolution

import { describe, it, expect } from "vitest";
import { resolveBinding, resolveAllBindings } from "./bindings.js";
import type { Binding } from "./types.js";
import { toBindings } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function binding(
  agentId: string,
  channel: string,
  accountId?: string,
  peer?: { kind: "group" | "dm" | "thread"; id: string },
): Binding {
  return {
    agentId,
    match: {
      channel,
      ...(accountId !== undefined && { accountId }),
      ...(peer !== undefined && { peer }),
    },
  };
}

// ---------------------------------------------------------------------------
// resolveBinding
// ---------------------------------------------------------------------------

describe("resolveBinding", () => {
  it("returns undefined when no bindings exist", () => {
    const result = resolveBinding([], { channel: "discord" });
    expect(result).toBeUndefined();
  });

  it("returns undefined when nothing matches", () => {
    const bindings = [binding("major", "discord", "major")];
    const result = resolveBinding(bindings, { channel: "feishu" });
    expect(result).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Channel-only matching
  // -----------------------------------------------------------------------

  it("matches by channel only", () => {
    const bindings = [binding("major", "discord")];
    const result = resolveBinding(bindings, { channel: "discord" });
    expect(result?.agentId).toBe("major");
  });

  it("channel-only binding matches regardless of query accountId", () => {
    const bindings = [binding("major", "discord")];
    const result = resolveBinding(bindings, {
      channel: "discord",
      accountId: "any-account",
    });
    expect(result?.agentId).toBe("major");
  });

  it("channel-only binding matches regardless of query peer", () => {
    const bindings = [binding("major", "discord")];
    const result = resolveBinding(bindings, {
      channel: "discord",
      accountId: "any",
      peer: { kind: "group", id: "123" },
    });
    expect(result?.agentId).toBe("major");
  });

  // -----------------------------------------------------------------------
  // Channel + accountId matching
  // -----------------------------------------------------------------------

  it("matches by channel + accountId", () => {
    const bindings = [binding("major", "discord", "major")];
    const result = resolveBinding(bindings, {
      channel: "discord",
      accountId: "major",
    });
    expect(result?.agentId).toBe("major");
  });

  it("does not match when accountId differs", () => {
    const bindings = [binding("major", "discord", "major")];
    const result = resolveBinding(bindings, {
      channel: "discord",
      accountId: "other",
    });
    expect(result).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Channel + accountId + peer matching
  // -----------------------------------------------------------------------

  it("matches by channel + accountId + peer", () => {
    const bindings = [
      binding("sac", "discord", "laughingman", {
        kind: "group",
        id: "1484372470306963547",
      }),
    ];
    const result = resolveBinding(bindings, {
      channel: "discord",
      accountId: "laughingman",
      peer: { kind: "group", id: "1484372470306963547" },
    });
    expect(result?.agentId).toBe("sac");
  });

  it("does not match when peer kind differs", () => {
    const bindings = [
      binding("sac", "discord", "laughingman", { kind: "group", id: "123" }),
    ];
    const result = resolveBinding(bindings, {
      channel: "discord",
      accountId: "laughingman",
      peer: { kind: "dm", id: "123" },
    });
    expect(result).toBeUndefined();
  });

  it("does not match when peer id differs", () => {
    const bindings = [
      binding("sac", "discord", "laughingman", { kind: "group", id: "123" }),
    ];
    const result = resolveBinding(bindings, {
      channel: "discord",
      accountId: "laughingman",
      peer: { kind: "group", id: "456" },
    });
    expect(result).toBeUndefined();
  });

  it("does not match peer binding when query has no peer", () => {
    const bindings = [
      binding("sac", "discord", "laughingman", { kind: "group", id: "123" }),
    ];
    const result = resolveBinding(bindings, {
      channel: "discord",
      accountId: "laughingman",
    });
    expect(result).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Priority / specificity
  // -----------------------------------------------------------------------

  it("more specific binding wins: (channel+account+peer) > (channel+account)", () => {
    const bindings = [
      binding("major", "discord", "laughingman"),
      binding("sac", "discord", "laughingman", { kind: "group", id: "123" }),
    ];
    const result = resolveBinding(bindings, {
      channel: "discord",
      accountId: "laughingman",
      peer: { kind: "group", id: "123" },
    });
    expect(result?.agentId).toBe("sac");
  });

  it("more specific binding wins: (channel+account) > (channel)", () => {
    const bindings = [
      binding("fallback", "discord"),
      binding("major", "discord", "major"),
    ];
    const result = resolveBinding(bindings, {
      channel: "discord",
      accountId: "major",
    });
    expect(result?.agentId).toBe("major");
  });

  it("more specific binding wins regardless of order in array", () => {
    const bindings = [
      binding("sac", "discord", "laughingman", { kind: "group", id: "123" }),
      binding("major", "discord", "laughingman"),
      binding("fallback", "discord"),
    ];
    const result = resolveBinding(bindings, {
      channel: "discord",
      accountId: "laughingman",
      peer: { kind: "group", id: "123" },
    });
    expect(result?.agentId).toBe("sac");
  });

  it("falls back to less specific binding when peer does not match", () => {
    const bindings = [
      binding("major", "discord", "laughingman"),
      binding("sac", "discord", "laughingman", { kind: "group", id: "123" }),
    ];
    // Different peer id → peer binding doesn't match → falls back to account binding
    const result = resolveBinding(bindings, {
      channel: "discord",
      accountId: "laughingman",
      peer: { kind: "group", id: "999" },
    });
    expect(result?.agentId).toBe("major");
  });

  it("falls back to channel-only when accountId does not match any specific binding", () => {
    const bindings = [
      binding("fallback", "discord"),
      binding("major", "discord", "major"),
    ];
    const result = resolveBinding(bindings, {
      channel: "discord",
      accountId: "unknown",
    });
    expect(result?.agentId).toBe("fallback");
  });

  // -----------------------------------------------------------------------
  // All three peer kinds
  // -----------------------------------------------------------------------

  it("supports peer.kind = dm", () => {
    const bindings = [
      binding("dm-agent", "discord", "major", { kind: "dm", id: "user-456" }),
    ];
    const result = resolveBinding(bindings, {
      channel: "discord",
      accountId: "major",
      peer: { kind: "dm", id: "user-456" },
    });
    expect(result?.agentId).toBe("dm-agent");
  });

  it("supports peer.kind = thread", () => {
    const bindings = [
      binding("thread-agent", "discord", "major", {
        kind: "thread",
        id: "thread-789",
      }),
    ];
    const result = resolveBinding(bindings, {
      channel: "discord",
      accountId: "major",
      peer: { kind: "thread", id: "thread-789" },
    });
    expect(result?.agentId).toBe("thread-agent");
  });

  // -----------------------------------------------------------------------
  // Multi-channel scenarios
  // -----------------------------------------------------------------------

  it("resolves correct agent across different channels", () => {
    const bindings = [
      binding("discord-agent", "discord", "major"),
      binding("feishu-agent", "feishu", "major"),
    ];

    const discord = resolveBinding(bindings, {
      channel: "discord",
      accountId: "major",
    });
    const feishu = resolveBinding(bindings, {
      channel: "feishu",
      accountId: "major",
    });

    expect(discord?.agentId).toBe("discord-agent");
    expect(feishu?.agentId).toBe("feishu-agent");
  });

  it("same agent bound to multiple channels", () => {
    const bindings = [
      binding("major", "discord", "major"),
      binding("major", "feishu", "major"),
    ];

    const discord = resolveBinding(bindings, {
      channel: "discord",
      accountId: "major",
    });
    const feishu = resolveBinding(bindings, {
      channel: "feishu",
      accountId: "major",
    });

    expect(discord?.agentId).toBe("major");
    expect(feishu?.agentId).toBe("major");
  });

  // -----------------------------------------------------------------------
  // PRD example scenario
  // -----------------------------------------------------------------------

  it("resolves PRD example: major as default, sac-chromium for specific group", () => {
    const bindings = [
      binding("major", "discord", "laughingman"),
      binding("sac-chromium", "discord", "laughingman", {
        kind: "group",
        id: "1484372470306963547",
      }),
    ];

    // General message → major
    const general = resolveBinding(bindings, {
      channel: "discord",
      accountId: "laughingman",
      peer: { kind: "group", id: "other-group" },
    });
    expect(general?.agentId).toBe("major");

    // Specific group → sac-chromium
    const specific = resolveBinding(bindings, {
      channel: "discord",
      accountId: "laughingman",
      peer: { kind: "group", id: "1484372470306963547" },
    });
    expect(specific?.agentId).toBe("sac-chromium");
  });

  // -----------------------------------------------------------------------
  // First-match tiebreaker
  // -----------------------------------------------------------------------

  it("returns first binding when multiple have same specificity", () => {
    const bindings = [
      binding("agent-a", "discord", "acct"),
      binding("agent-b", "discord", "acct"),
    ];
    const result = resolveBinding(bindings, {
      channel: "discord",
      accountId: "acct",
    });
    expect(result?.agentId).toBe("agent-a");
  });
});

// ---------------------------------------------------------------------------
// resolveAllBindings
// ---------------------------------------------------------------------------

describe("resolveAllBindings", () => {
  it("returns empty array when no bindings match", () => {
    const result = resolveAllBindings([], { channel: "discord" });
    expect(result).toEqual([]);
  });

  it("returns all matching bindings sorted by specificity", () => {
    const bindings = [
      binding("fallback", "discord"),
      binding("major", "discord", "major"),
      binding("specific", "discord", "major", { kind: "group", id: "123" }),
    ];
    const result = resolveAllBindings(bindings, {
      channel: "discord",
      accountId: "major",
      peer: { kind: "group", id: "123" },
    });
    expect(result).toHaveLength(3);
    expect(result[0].agentId).toBe("specific");
    expect(result[1].agentId).toBe("major");
    expect(result[2].agentId).toBe("fallback");
  });

  it("excludes non-matching bindings", () => {
    const bindings = [
      binding("discord-agent", "discord", "major"),
      binding("feishu-agent", "feishu", "major"),
    ];
    const result = resolveAllBindings(bindings, {
      channel: "discord",
      accountId: "major",
    });
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe("discord-agent");
  });
});

// ---------------------------------------------------------------------------
// toBindings (config parsing)
// ---------------------------------------------------------------------------

describe("toBindings", () => {
  const agents = [
    { id: "major", name: "Major" },
    { id: "sac", name: "SAC" },
  ];

  it("returns empty array when bindings config is undefined", () => {
    expect(toBindings(undefined, agents)).toEqual([]);
  });

  it("returns empty array when bindings config is empty", () => {
    expect(toBindings([], agents)).toEqual([]);
  });

  it("parses a simple channel+account binding", () => {
    const result = toBindings(
      [{ agentId: "major", match: { channel: "discord", accountId: "major" } }],
      agents,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      agentId: "major",
      match: { channel: "discord", accountId: "major" },
    });
  });

  it("parses a binding with peer", () => {
    const result = toBindings(
      [
        {
          agentId: "sac",
          match: {
            channel: "discord",
            accountId: "laughingman",
            peer: { kind: "group", id: "123" },
          },
        },
      ],
      agents,
    );
    expect(result).toHaveLength(1);
    expect(result[0].match.peer).toEqual({ kind: "group", id: "123" });
  });

  it("coerces peer.id to string (YAML may parse numbers)", () => {
    const result = toBindings(
      [
        {
          agentId: "sac",
          match: {
            channel: "discord",
            accountId: "acct",
            peer: { kind: "group", id: 1484372470306963547 as unknown as string },
          },
        },
      ],
      agents,
    );
    expect(typeof result[0].match.peer?.id).toBe("string");
  });

  it("throws on unknown agentId", () => {
    expect(() =>
      toBindings(
        [{ agentId: "nonexistent", match: { channel: "discord" } }],
        agents,
      ),
    ).toThrow('agentId "nonexistent" does not match any defined agent');
  });

  it("throws on missing match.channel", () => {
    expect(() =>
      toBindings(
        [{ agentId: "major", match: { channel: "" } }],
        agents,
      ),
    ).toThrow("match.channel is required");
  });

  it("throws on invalid peer.kind", () => {
    expect(() =>
      toBindings(
        [
          {
            agentId: "major",
            match: {
              channel: "discord",
              peer: { kind: "invalid", id: "123" },
            },
          },
        ],
        agents,
      ),
    ).toThrow('invalid peer.kind "invalid"');
  });

  it("throws on missing peer.id when peer is specified", () => {
    expect(() =>
      toBindings(
        [
          {
            agentId: "major",
            match: {
              channel: "discord",
              peer: { kind: "group", id: "" },
            },
          },
        ],
        agents,
      ),
    ).toThrow("peer.id is required when peer is specified");
  });

  it("parses multiple bindings", () => {
    const result = toBindings(
      [
        { agentId: "major", match: { channel: "discord", accountId: "major" } },
        { agentId: "major", match: { channel: "feishu", accountId: "major" } },
        {
          agentId: "sac",
          match: {
            channel: "discord",
            accountId: "laughingman",
            peer: { kind: "group", id: "123" },
          },
        },
      ],
      agents,
    );
    expect(result).toHaveLength(3);
    expect(result[0].match.channel).toBe("discord");
    expect(result[1].match.channel).toBe("feishu");
    expect(result[2].match.peer?.kind).toBe("group");
  });
});
