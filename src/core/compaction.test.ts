// src/core/compaction.test.ts — Unit tests for context compaction

import { describe, it, expect, vi } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { CompactionConfig } from "./types.js";
import {
  estimateMessageTokens,
  estimateTotalTokens,
  shouldCompact,
  buildSummaryPrompt,
  createSummaryMessage,
  compactMessages,
  createTransformContext,
  resolveCompactionConfig,
} from "./compaction.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(role: string, text: string, timestamp?: number): AgentMessage {
  return {
    role,
    content: text,
    timestamp: timestamp ?? Date.now(),
  } as AgentMessage;
}

function makeMessages(count: number, charsPerMessage = 100): AgentMessage[] {
  return Array.from({ length: count }, (_, i) =>
    makeMessage(
      i % 2 === 0 ? "user" : "assistant",
      "x".repeat(charsPerMessage),
      1000 + i,
    ),
  );
}

function makeConfig(overrides?: Partial<CompactionConfig>): CompactionConfig {
  return {
    mode: "safeguard",
    contextWindow: 128_000,
    threshold: 0.8,
    preserveRecent: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

describe("estimateMessageTokens", () => {
  it("estimates tokens from string content (4 chars = 1 token)", () => {
    const msg = makeMessage("user", "hello world"); // 11 chars
    expect(estimateMessageTokens(msg)).toBe(3); // ceil(11/4)
  });

  it("estimates tokens from empty string", () => {
    const msg = makeMessage("user", "");
    expect(estimateMessageTokens(msg)).toBe(0);
  });

  it("estimates tokens from long content", () => {
    const msg = makeMessage("user", "a".repeat(400));
    expect(estimateMessageTokens(msg)).toBe(100);
  });

  it("handles content block arrays", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ],
      timestamp: Date.now(),
    } as AgentMessage;
    // "hello\nworld" = 11 chars → ceil(11/4) = 3
    expect(estimateMessageTokens(msg)).toBe(3);
  });
});

describe("estimateTotalTokens", () => {
  it("sums token estimates across all messages", () => {
    const messages = [
      makeMessage("user", "a".repeat(40)), // 10 tokens
      makeMessage("assistant", "b".repeat(80)), // 20 tokens
    ];
    expect(estimateTotalTokens(messages)).toBe(30);
  });

  it("returns 0 for empty array", () => {
    expect(estimateTotalTokens([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// shouldCompact
// ---------------------------------------------------------------------------

describe("shouldCompact", () => {
  it("returns false when mode is off", () => {
    const messages = makeMessages(20, 50_000); // very large
    expect(shouldCompact(messages, makeConfig({ mode: "off" }))).toBe(false);
  });

  it("returns false when under threshold", () => {
    // 10 messages * 100 chars = 1000 chars → 250 tokens << 128000 * 0.8
    const messages = makeMessages(10, 100);
    expect(shouldCompact(messages, makeConfig())).toBe(false);
  });

  it("returns true when over safeguard threshold", () => {
    // 128000 * 0.8 = 102400 tokens → need > 102400 * 4 = 409600 chars total
    // 50 messages * 10000 chars = 500000 chars → 125000 tokens > 102400
    const messages = makeMessages(50, 10_000);
    expect(shouldCompact(messages, makeConfig())).toBe(true);
  });

  it("returns false when messages count <= preserveRecent", () => {
    // Even if total tokens are high, can't compact if nothing to summarize
    const messages = makeMessages(10, 50_000); // 10 messages, preserveRecent=10
    expect(shouldCompact(messages, makeConfig({ preserveRecent: 10 }))).toBe(false);
  });

  it("uses aggressive threshold (0.5) by default for aggressive mode", () => {
    // 128000 * 0.5 = 64000 tokens → need > 64000 * 4 = 256000 chars
    // 30 messages * 10000 chars = 300000 chars → 75000 tokens > 64000
    const messages = makeMessages(30, 10_000);
    const config = makeConfig({ mode: "aggressive", threshold: 0.5 });
    expect(shouldCompact(messages, config)).toBe(true);
  });

  it("supports custom threshold", () => {
    // 128000 * 0.3 = 38400 tokens
    // 20 messages * 10000 chars = 200000 chars → 50000 tokens > 38400
    const messages = makeMessages(20, 10_000);
    const config = makeConfig({ threshold: 0.3 });
    expect(shouldCompact(messages, config)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildSummaryPrompt
// ---------------------------------------------------------------------------

describe("buildSummaryPrompt", () => {
  it("formats messages into a summary prompt with roles", () => {
    const messages = [
      makeMessage("user", "What is 2+2?"),
      makeMessage("assistant", "2+2 equals 4."),
    ];

    const prompt = buildSummaryPrompt(messages);

    expect(prompt).toContain("[user]: What is 2+2?");
    expect(prompt).toContain("[assistant]: 2+2 equals 4.");
    expect(prompt).toContain("Summarize the following conversation");
  });

  it("handles empty messages array", () => {
    const prompt = buildSummaryPrompt([]);
    expect(prompt).toContain("Summarize the following conversation");
  });
});

// ---------------------------------------------------------------------------
// createSummaryMessage
// ---------------------------------------------------------------------------

describe("createSummaryMessage", () => {
  it("creates a user message with summary prefix", () => {
    const msg = createSummaryMessage("The user asked about math.");

    const m = msg as unknown as Record<string, unknown>;
    expect(m.role).toBe("user");
    expect(m.content).toContain("[Previous conversation summary]");
    expect(m.content).toContain("The user asked about math.");
  });
});

// ---------------------------------------------------------------------------
// resolveCompactionConfig
// ---------------------------------------------------------------------------

describe("resolveCompactionConfig", () => {
  it("returns safeguard defaults when no config given", () => {
    const config = resolveCompactionConfig();
    expect(config.mode).toBe("safeguard");
    expect(config.contextWindow).toBe(128_000);
    expect(config.threshold).toBe(0.8);
    expect(config.preserveRecent).toBe(10);
  });

  it("applies aggressive defaults for aggressive mode", () => {
    const config = resolveCompactionConfig({ mode: "aggressive" });
    expect(config.threshold).toBe(0.5);
  });

  it("respects explicit overrides", () => {
    const config = resolveCompactionConfig({
      mode: "safeguard",
      contextWindow: 200_000,
      threshold: 0.7,
      preserveRecent: 5,
    });
    expect(config.contextWindow).toBe(200_000);
    expect(config.threshold).toBe(0.7);
    expect(config.preserveRecent).toBe(5);
  });

  it("uses off threshold (1) for off mode", () => {
    const config = resolveCompactionConfig({ mode: "off" });
    expect(config.threshold).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// compactMessages
// ---------------------------------------------------------------------------

describe("compactMessages", () => {
  it("returns original messages when compaction not needed", async () => {
    const messages = makeMessages(5, 100); // very small
    const summarize = vi.fn();

    const result = await compactMessages({
      messages,
      config: makeConfig(),
      summarize,
    });

    expect(result).toBe(messages); // same reference
    expect(summarize).not.toHaveBeenCalled();
  });

  it("returns original messages when mode is off", async () => {
    const messages = makeMessages(50, 10_000);
    const summarize = vi.fn();

    const result = await compactMessages({
      messages,
      config: makeConfig({ mode: "off" }),
      summarize,
    });

    expect(result).toBe(messages);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("compacts messages when threshold is exceeded", async () => {
    const messages = makeMessages(50, 10_000);
    const summarize = vi.fn().mockResolvedValue("This is a summary.");

    const result = await compactMessages({
      messages,
      config: makeConfig({ preserveRecent: 10 }),
      summarize,
    });

    // Should have 1 summary + 10 recent = 11 messages
    expect(result).toHaveLength(11);
    expect(summarize).toHaveBeenCalledOnce();

    // First message should be the summary
    const summary = result[0] as unknown as Record<string, unknown>;
    expect(summary.role).toBe("user");
    expect(summary.content).toContain("[Previous conversation summary]");
    expect(summary.content).toContain("This is a summary.");

    // Last 10 should be from the original
    for (let i = 1; i < result.length; i++) {
      expect(result[i]).toBe(messages[40 + i - 1]);
    }
  });

  it("passes the summary prompt to the summarize function", async () => {
    const messages = makeMessages(50, 10_000);
    const summarize = vi.fn().mockResolvedValue("summary");

    await compactMessages({
      messages,
      config: makeConfig({ preserveRecent: 10 }),
      summarize,
    });

    const prompt = summarize.mock.calls[0][0] as string;
    expect(prompt).toContain("Summarize the following conversation");
  });

  it("returns original messages when summarize throws", async () => {
    const messages = makeMessages(50, 10_000);
    const summarize = vi.fn().mockRejectedValue(new Error("LLM failed"));

    const result = await compactMessages({
      messages,
      config: makeConfig({ preserveRecent: 10 }),
      summarize,
    });

    expect(result).toBe(messages); // fallback to original
  });

  it("passes abort signal to summarize", async () => {
    const messages = makeMessages(50, 10_000);
    const controller = new AbortController();
    const summarize = vi.fn().mockResolvedValue("summary");

    await compactMessages({
      messages,
      config: makeConfig({ preserveRecent: 10 }),
      summarize,
      signal: controller.signal,
    });

    expect(summarize).toHaveBeenCalledWith(expect.any(String), controller.signal);
  });
});

// ---------------------------------------------------------------------------
// createTransformContext
// ---------------------------------------------------------------------------

describe("createTransformContext", () => {
  it("returns undefined when mode is off", () => {
    const transform = createTransformContext({
      config: makeConfig({ mode: "off" }),
      summarize: vi.fn(),
    });

    expect(transform).toBeUndefined();
  });

  it("returns a function when mode is safeguard", () => {
    const transform = createTransformContext({
      config: makeConfig({ mode: "safeguard" }),
      summarize: vi.fn(),
    });

    expect(transform).toBeTypeOf("function");
  });

  it("returns a function when mode is aggressive", () => {
    const transform = createTransformContext({
      config: makeConfig({ mode: "aggressive", threshold: 0.5 }),
      summarize: vi.fn(),
    });

    expect(transform).toBeTypeOf("function");
  });

  it("the returned function compacts messages when threshold exceeded", async () => {
    const summarize = vi.fn().mockResolvedValue("compacted summary");
    const transform = createTransformContext({
      config: makeConfig({ preserveRecent: 5 }),
      summarize,
    })!;

    const messages = makeMessages(50, 10_000);
    const result = await transform(messages);

    // 1 summary + 5 recent = 6
    expect(result).toHaveLength(6);
    expect(summarize).toHaveBeenCalledOnce();
  });

  it("the returned function passes through when under threshold", async () => {
    const summarize = vi.fn();
    const transform = createTransformContext({
      config: makeConfig(),
      summarize,
    })!;

    const messages = makeMessages(5, 100);
    const result = await transform(messages);

    expect(result).toBe(messages);
    expect(summarize).not.toHaveBeenCalled();
  });
});
