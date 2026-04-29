// src/core/compaction.test.ts — Unit tests for compaction config resolution

import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

import {
  estimateTotalTokens,
  resolveCompactionConfig,
} from "./compaction.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(role: string, text: string): AgentMessage {
  if (role === "assistant") {
    return {
      role,
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    } as unknown as AgentMessage;
  }
  return { role, content: text, timestamp: Date.now() } as AgentMessage;
}

// ---------------------------------------------------------------------------
// estimateTotalTokens
// ---------------------------------------------------------------------------

describe("estimateTotalTokens", () => {
  it("sums across messages", () => {
    const messages = [
      makeMessage("user", "a".repeat(40)),
      makeMessage("assistant", "b".repeat(80)),
    ];
    const total = estimateTotalTokens(messages);
    expect(total).toBeGreaterThan(0);
  });

  it("returns 0 for empty array", () => {
    expect(estimateTotalTokens([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveCompactionConfig
// ---------------------------------------------------------------------------

describe("resolveCompactionConfig", () => {
  it("returns safeguard defaults when no config given", () => {
    const config = resolveCompactionConfig();
    expect(config.mode).toBe("safeguard");
    expect(config.contextWindow).toBe(200_000);
    expect(config.threshold).toBe(0.8);
    expect(config.reserveTokens).toBe(20_000);
  });

  it("applies aggressive defaults for aggressive mode", () => {
    const config = resolveCompactionConfig({ mode: "aggressive" });
    expect(config.threshold).toBe(0.5);
  });

  it("respects explicit overrides", () => {
    const config = resolveCompactionConfig({
      mode: "safeguard",
      contextWindow: 128_000,
      threshold: 0.7,
      preserveRecent: 5,
      reserveTokens: 32_000,
    });
    expect(config.contextWindow).toBe(128_000);
    expect(config.threshold).toBe(0.7);
    expect(config.preserveRecent).toBe(5);
    expect(config.reserveTokens).toBe(32_000);
  });
});
