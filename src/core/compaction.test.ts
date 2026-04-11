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
  isContextOverflow,
  forceCompact,
  iterativeCompact,
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

// ---------------------------------------------------------------------------
// isContextOverflow
// ---------------------------------------------------------------------------

describe("isContextOverflow", () => {
  it("returns false for undefined or empty error message", () => {
    expect(isContextOverflow(undefined)).toBe(false);
    expect(isContextOverflow("")).toBe(false);
  });

  it("detects Anthropic overflow error", () => {
    expect(isContextOverflow("prompt is too long: 213462 tokens > 200000 maximum")).toBe(true);
  });

  it("detects OpenAI overflow error", () => {
    expect(isContextOverflow("Your input exceeds the context window of this model")).toBe(true);
  });

  it("detects Google Gemini overflow error", () => {
    expect(isContextOverflow("The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)")).toBe(true);
  });

  it("detects generic overflow patterns", () => {
    expect(isContextOverflow("context length exceeded")).toBe(true);
    expect(isContextOverflow("too many tokens in request")).toBe(true);
    expect(isContextOverflow("token limit exceeded")).toBe(true);
  });

  it("detects Cerebras 400/413 status code errors", () => {
    expect(isContextOverflow("400 status code (no body)")).toBe(true);
    expect(isContextOverflow("413 (no body)")).toBe(true);
  });

  it("returns false for non-overflow errors", () => {
    expect(isContextOverflow("rate limit exceeded")).toBe(false);
    expect(isContextOverflow("invalid API key")).toBe(false);
    expect(isContextOverflow("network timeout")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// forceCompact
// ---------------------------------------------------------------------------

describe("forceCompact", () => {
  it("compacts messages regardless of threshold", async () => {
    // Small messages that wouldn't trigger normal compaction
    const messages = makeMessages(20, 100);
    const summarize = vi.fn().mockResolvedValue("forced summary");

    const result = await forceCompact({
      messages,
      config: makeConfig({ preserveRecent: 5 }),
      summarize,
    });

    // Should have 1 summary + 5 recent = 6 messages
    expect(result).toHaveLength(6);
    expect(summarize).toHaveBeenCalledOnce();

    const summary = result[0] as unknown as Record<string, unknown>;
    expect(summary.content).toContain("[Previous conversation summary]");
    expect(summary.content).toContain("forced summary");
  });

  it("returns original messages when not enough to compact", async () => {
    const messages = makeMessages(5, 100);
    const summarize = vi.fn();

    const result = await forceCompact({
      messages,
      config: makeConfig({ preserveRecent: 5 }),
      summarize,
    });

    expect(result).toBe(messages);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("throws when summarize fails", async () => {
    const messages = makeMessages(20, 100);
    const summarize = vi.fn().mockRejectedValue(new Error("LLM error"));

    await expect(
      forceCompact({
        messages,
        config: makeConfig({ preserveRecent: 5 }),
        summarize,
      }),
    ).rejects.toThrow("LLM error");
  });
});

// ---------------------------------------------------------------------------
// iterativeCompact
// ---------------------------------------------------------------------------

describe("iterativeCompact", () => {
  it("returns messages unchanged if already under threshold", async () => {
    const messages = makeMessages(5, 100);
    const summarize = vi.fn();

    const result = await iterativeCompact({
      messages,
      config: makeConfig(),
      summarize,
    });

    expect(result).toBe(messages);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("performs multiple rounds until under threshold", async () => {
    // Create messages that need multiple rounds of compaction
    // Start with 100 messages * 5000 chars = 500000 chars → ~166666 tokens (with JSON estimate)
    const messages = makeMessages(100, 5000);
    let callCount = 0;
    const summarize = vi.fn().mockImplementation(() => {
      callCount++;
      // Each summary is small, simulating good compression
      return Promise.resolve(`Round ${callCount} summary - brief`);
    });

    const result = await iterativeCompact({
      messages,
      config: makeConfig({
        contextWindow: 128_000,
        threshold: 0.5,
        preserveRecent: 10,
      }),
      summarize,
      maxRounds: 3,
    });

    // Should have compacted at least once
    expect(summarize).toHaveBeenCalled();
    // Result should be smaller than original
    expect(result.length).toBeLessThan(messages.length);
  });

  it("stops at max rounds even if still over threshold", async () => {
    // Very large messages that can't be compacted enough
    const messages = makeMessages(20, 50_000);
    const summarize = vi.fn().mockResolvedValue("x".repeat(40_000)); // Summary is still big

    const result = await iterativeCompact({
      messages,
      config: makeConfig({
        contextWindow: 10_000,
        threshold: 0.5,
        preserveRecent: 5,
      }),
      summarize,
      maxRounds: 2,
    });

    // Should have attempted maxRounds compactions
    expect(summarize).toHaveBeenCalledTimes(2);
    // Should return what we have even if still over threshold
    expect(result).toBeDefined();
  });

  it("stops when not enough messages to compact further", async () => {
    // 15 messages with large content that exceeds threshold
    // preserveRecent=14 means after first compaction we have 1 summary + 14 recent = 15 messages
    // But 15 messages with preserveRecent=14 means only 1 message can be summarized
    // Eventually we hit the minimum and can't compact further
    const messages = makeMessages(15, 10_000);
    const summarize = vi.fn().mockResolvedValue("short summary");

    const result = await iterativeCompact({
      messages,
      config: makeConfig({
        contextWindow: 50_000,
        threshold: 0.3,
        preserveRecent: 14,
      }),
      summarize,
      maxRounds: 5,
    });

    // Should have attempted compaction
    expect(summarize).toHaveBeenCalled();
    // Result should be returned
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Token estimation with JSON content
// ---------------------------------------------------------------------------

describe("estimateMessageTokens with JSON content", () => {
  it("uses more conservative estimate for JSON-like content", () => {
    const jsonMsg = makeMessage("assistant", '{"type":"text","output":"result"}');
    const textMsg = makeMessage("user", "This is a plain text message here");

    // JSON should use 3 chars/token, text uses 4 chars/token
    // JSON: 35 chars → ceil(35/3) = 12 tokens
    // Text: 35 chars → ceil(35/4) = 9 tokens
    expect(estimateMessageTokens(jsonMsg)).toBeGreaterThan(estimateMessageTokens(textMsg));
  });

  it("detects array JSON content", () => {
    const arrayMsg = makeMessage("assistant", '[{"id":1},{"id":2}]');
    // 19 chars, JSON-like → ceil(19/3) = 7 tokens
    expect(estimateMessageTokens(arrayMsg)).toBe(7);
  });

  it("detects tool result patterns", () => {
    const toolResultMsg = makeMessage("assistant", 'Some prefix "output": "tool result here"');
    // Contains "output": pattern, should be treated as JSON-like
    const plainMsg = makeMessage("user", "Some prefix output tool result here");

    expect(estimateMessageTokens(toolResultMsg)).toBeGreaterThan(estimateMessageTokens(plainMsg));
  });
});

// ---------------------------------------------------------------------------
// Tool use/result pairing protection (Issue #131)
// ---------------------------------------------------------------------------

describe("compaction tool_use/tool_result pairing", () => {
  function makeToolUseMessage(id: string): AgentMessage {
    return {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check that." },
        { type: "tool_use", id, name: "read_file", input: { path: "test.txt" } },
      ],
      timestamp: Date.now(),
    } as unknown as AgentMessage;
  }

  function makeToolResultMessage(id: string): AgentMessage {
    return {
      role: "tool_result",
      content: [
        { type: "tool_result", output: "file contents here", toolCallId: id },
      ],
      timestamp: Date.now(),
    } as unknown as AgentMessage;
  }

  it("does not split between tool_use and tool_result (forceCompact)", async () => {
    // Index:  0     1         2       3        4       5              6            7     8         9
    // Msgs:  [user, assistant, user, assistant, user, assistant+tool, tool_result, user, assistant, user]
    // With preserveRecent=4, naive split at index 6 puts tool_result at front — orphaned!
    const messages: AgentMessage[] = [
      makeMessage("user", "x".repeat(10000)),
      makeMessage("assistant", "x".repeat(10000)),
      makeMessage("user", "x".repeat(10000)),
      makeMessage("assistant", "x".repeat(10000)),
      makeMessage("user", "x".repeat(10000)),
      makeToolUseMessage("tool-1"),
      makeToolResultMessage("tool-1"),
      makeMessage("user", "short"),
      makeMessage("assistant", "short"),
      makeMessage("user", "short"),
    ];

    const summarize = vi.fn().mockResolvedValue("summary");

    const result = await forceCompact({
      messages,
      config: makeConfig({ preserveRecent: 4 }),
      summarize,
    });

    // The result should NOT start with a tool_result (after summary)
    const firstRecent = result[1] as unknown as Record<string, unknown>;
    expect(firstRecent.role).not.toBe("tool_result");
    expect(summarize).toHaveBeenCalledOnce();
  });

  it("keeps tool_use and tool_result together when split would occur between them", async () => {
    // [user, assistant+tool_use, tool_result, user, assistant]
    // preserveRecent=2 would try to split at index 3, putting tool_result at front
    const messages: AgentMessage[] = [
      makeMessage("user", "x".repeat(20000)),
      makeToolUseMessage("tool-1"),
      makeToolResultMessage("tool-1"),
      makeMessage("user", "x".repeat(100)),
      makeMessage("assistant", "x".repeat(100)),
    ];

    const summarize = vi.fn().mockResolvedValue("summary");

    const result = await forceCompact({
      messages,
      config: makeConfig({ preserveRecent: 2 }),
      summarize,
    });

    // First message after summary should not be tool_result
    const firstRecent = result[1] as unknown as Record<string, unknown>;
    expect(firstRecent.role).not.toBe("tool_result");
  });

  it("handles multiple consecutive tool_results", async () => {
    // [user, assistant+tool_use+tool_use, tool_result, tool_result, user]
    const toolUseMsg: AgentMessage = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "tool_a", input: {} },
        { type: "tool_use", id: "t2", name: "tool_b", input: {} },
      ],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const messages: AgentMessage[] = [
      makeMessage("user", "x".repeat(20000)),
      toolUseMsg,
      makeToolResultMessage("t1"),
      makeToolResultMessage("t2"),
      makeMessage("user", "x".repeat(100)),
    ];

    const summarize = vi.fn().mockResolvedValue("summary");

    const result = await forceCompact({
      messages,
      config: makeConfig({ preserveRecent: 2 }),
      summarize,
    });

    // First message after summary should not be tool_result
    const firstRecent = result[1] as unknown as Record<string, unknown>;
    expect(firstRecent.role).not.toBe("tool_result");
  });

  it("does not orphan tool_use when split lands right after it (backward check)", async () => {
    // Scenario: split falls right after assistant+tool_use, before the tool_result.
    // The forward check won't catch this because recentMessages[0] is NOT a tool_result —
    // it's a user message. The backward check must detect that oldMessages ends with tool_use.
    //
    // Index:  0     1              2            3     4         5
    // Msgs:  [user, assistant+tool, tool_result, user, assistant, user]
    // preserveRecent=3 → naive split at index 3 → oldMessages = [user, assistant+tool, tool_result]
    // That's fine (tool pair is together in old). But preserveRecent=2 → naive split at index 4
    // → oldMessages = [..., assistant+tool, tool_result, user] — also fine.
    //
    // The real problem: preserveRecent=4 → split at index 2 → oldMessages = [user, assistant+tool]
    // The assistant+tool_use is orphaned in oldMessages with no tool_result!
    // Backward check should move split to index 1.
    const messages: AgentMessage[] = [
      makeMessage("user", "x".repeat(20000)),
      makeToolUseMessage("tool-1"),
      makeToolResultMessage("tool-1"),
      makeMessage("user", "x".repeat(100)),
      makeMessage("assistant", "x".repeat(100)),
      makeMessage("user", "x".repeat(100)),
    ];

    const summarize = vi.fn().mockResolvedValue("summary");

    const result = await forceCompact({
      messages,
      config: makeConfig({ preserveRecent: 4 }),
      summarize,
    });

    // The assistant+tool_use and its tool_result should both be in recent (after summary)
    const roles = result.slice(1).map((m) => (m as unknown as Record<string, unknown>).role);
    // assistant+tool_use must not be in the summarized portion — it should appear in recent
    const hasToolUseInRecent = result.slice(1).some((m) => {
      const msg = m as unknown as Record<string, unknown>;
      return msg.role === "assistant" && Array.isArray(msg.content) &&
        (msg.content as Array<Record<string, unknown>>).some((b) => b.type === "tool_use");
    });
    expect(hasToolUseInRecent).toBe(true);
    // And its tool_result should follow
    expect(roles).toContain("tool_result");
  });
});
