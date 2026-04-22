// src/core/compaction.test.ts — Unit tests for context compaction (SDK-backed)

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { CompactionConfig } from "./types.js";

// Mock the SDK's generateSummary so we control its output
vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...actual,
    generateSummary: vi.fn().mockResolvedValue("SDK summary"),
  };
});

import { generateSummary } from "@mariozechner/pi-coding-agent";
import {
  estimateMessageTokens,
  estimateTotalTokens,
  shouldCompact,
  createSummaryMessage,
  compactMessages,
  createTransformContext,
  resolveCompactionConfig,
  isContextOverflow,
  forceCompact,
  iterativeCompact,
} from "./compaction.js";

const mockGenerateSummary = vi.mocked(generateSummary);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(role: string, text: string, timestamp?: number): AgentMessage {
  if (role === "assistant") {
    return {
      role,
      content: [{ type: "text", text }],
      timestamp: timestamp ?? Date.now(),
    } as unknown as AgentMessage;
  }
  return { role, content: text, timestamp: timestamp ?? Date.now() } as AgentMessage;
}

function makeMessages(count: number, charsPerMessage = 100): AgentMessage[] {
  return Array.from({ length: count }, (_, i) =>
    makeMessage(i % 2 === 0 ? "user" : "assistant", "x".repeat(charsPerMessage), 1000 + i),
  );
}

function makeConfig(overrides?: Partial<CompactionConfig>): CompactionConfig {
  return { mode: "safeguard", contextWindow: 200_000, threshold: 0.8, ...overrides };
}

const dummyModel = {} as Parameters<typeof compactMessages>[0]["model"];
const dummyApiKey = "test-key";

beforeEach(() => {
  mockGenerateSummary.mockReset().mockResolvedValue("SDK summary");
});

// ---------------------------------------------------------------------------
// Token estimation (delegates to SDK estimateTokens)
// ---------------------------------------------------------------------------

describe("estimateMessageTokens", () => {
  it("estimates tokens using chars/4 heuristic", () => {
    const msg = makeMessage("user", "hello world"); // 11 chars
    expect(estimateMessageTokens(msg)).toBe(3); // ceil(11/4)
  });

  it("returns 0 for empty string", () => {
    expect(estimateMessageTokens(makeMessage("user", ""))).toBe(0);
  });

  it("estimates long content", () => {
    expect(estimateMessageTokens(makeMessage("user", "a".repeat(400)))).toBe(100);
  });
});

describe("estimateTotalTokens", () => {
  it("sums across messages", () => {
    const messages = [
      makeMessage("user", "a".repeat(40)),     // 10 tokens
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
    const messages = makeMessages(20, 50_000);
    expect(shouldCompact(messages, makeConfig({ mode: "off" }))).toBe(false);
  });

  it("returns false when under threshold", () => {
    const messages = makeMessages(10, 100);
    expect(shouldCompact(messages, makeConfig())).toBe(false);
  });

  it("returns true when over threshold", () => {
    // 200k * 0.8 = 160k reserve = 40k tokens. Need > 160k tokens → 640k chars.
    // 50 * 15000 = 750k chars → ~187k tokens > 160k threshold
    const messages = makeMessages(50, 15_000);
    expect(shouldCompact(messages, makeConfig())).toBe(true);
  });

  it("uses aggressive threshold", () => {
    // 200k * 0.5 = 100k reserve. Need context > 100k tokens.
    // 30 * 15000 = 450k chars → ~112k tokens > 100k
    const messages = makeMessages(30, 15_000);
    expect(shouldCompact(messages, makeConfig({ mode: "aggressive", threshold: 0.5 }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createSummaryMessage
// ---------------------------------------------------------------------------

describe("createSummaryMessage", () => {
  it("creates a user message with array content containing the summary", () => {
    const msg = createSummaryMessage("The user asked about math.");

    const m = msg as unknown as { role: string; content: Array<{ type: string; text: string }> };
    expect(m.role).toBe("user");
    expect(Array.isArray(m.content)).toBe(true);
    expect(m.content).toHaveLength(1);
    expect(m.content[0].type).toBe("text");
    expect(m.content[0].text).toContain("[Previous conversation summary]");
    expect(m.content[0].text).toContain("The user asked about math.");
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
    });
    expect(config.contextWindow).toBe(128_000);
    expect(config.threshold).toBe(0.7);
    expect(config.preserveRecent).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// compactMessages
// ---------------------------------------------------------------------------

describe("compactMessages", () => {
  it("returns original messages when compaction not needed", async () => {
    const messages = makeMessages(5, 100);

    const result = await compactMessages({
      messages, config: makeConfig(), model: dummyModel, apiKey: dummyApiKey,
    });

    expect(result).toBe(messages);
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });

  it("returns original messages when mode is off", async () => {
    const messages = makeMessages(50, 15_000);

    const result = await compactMessages({
      messages, config: makeConfig({ mode: "off" }), model: dummyModel, apiKey: dummyApiKey,
    });

    expect(result).toBe(messages);
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });

  it("compacts messages when threshold is exceeded", async () => {
    const messages = makeMessages(50, 15_000);
    mockGenerateSummary.mockResolvedValue("This is a summary.");

    const result = await compactMessages({
      messages, config: makeConfig(), model: dummyModel, apiKey: dummyApiKey,
    });

    expect(result.length).toBeLessThan(messages.length);
    expect(mockGenerateSummary).toHaveBeenCalledOnce();

    const summary = result[0] as unknown as { role: string; content: Array<{ type: string; text: string }> };
    expect(summary.role).toBe("user");
    expect(summary.content[0].text).toContain("[Previous conversation summary]");
  });

  it("returns original messages when generateSummary throws", async () => {
    const messages = makeMessages(50, 15_000);
    mockGenerateSummary.mockRejectedValue(new Error("LLM failed"));

    const result = await compactMessages({
      messages, config: makeConfig(), model: dummyModel, apiKey: dummyApiKey,
    });

    expect(result).toBe(messages);
  });
});

// ---------------------------------------------------------------------------
// createTransformContext
// ---------------------------------------------------------------------------

describe("createTransformContext", () => {
  it("returns undefined when mode is off", () => {
    const transform = createTransformContext({
      config: makeConfig({ mode: "off" }), model: dummyModel, apiKey: dummyApiKey,
    });
    expect(transform).toBeUndefined();
  });

  it("returns a function when mode is safeguard", () => {
    const transform = createTransformContext({
      config: makeConfig(), model: dummyModel, apiKey: dummyApiKey,
    });
    expect(transform).toBeTypeOf("function");
  });

  it("the returned function compacts when threshold exceeded", async () => {
    mockGenerateSummary.mockResolvedValue("compacted summary");
    const transform = createTransformContext({
      config: makeConfig(), model: dummyModel, apiKey: dummyApiKey,
    })!;

    const messages = makeMessages(50, 15_000);
    const result = await transform(messages);

    expect(result.length).toBeLessThan(messages.length);
    expect(mockGenerateSummary).toHaveBeenCalledOnce();
  });

  it("the returned function passes through when under threshold", async () => {
    const transform = createTransformContext({
      config: makeConfig(), model: dummyModel, apiKey: dummyApiKey,
    })!;

    const messages = makeMessages(5, 100);
    const result = await transform(messages);

    expect(result).toBe(messages);
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// isContextOverflow
// ---------------------------------------------------------------------------

describe("isContextOverflow", () => {
  it("returns false for undefined or empty", () => {
    expect(isContextOverflow(undefined)).toBe(false);
    expect(isContextOverflow("")).toBe(false);
  });

  it("detects Anthropic overflow", () => {
    expect(isContextOverflow("prompt is too long: 213462 tokens > 200000 maximum")).toBe(true);
  });

  it("detects OpenAI overflow", () => {
    expect(isContextOverflow("Your input exceeds the context window of this model")).toBe(true);
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
  });
});

// ---------------------------------------------------------------------------
// forceCompact
// ---------------------------------------------------------------------------

describe("forceCompact", () => {
  it("compacts messages regardless of threshold", async () => {
    const messages = makeMessages(20, 100);
    mockGenerateSummary.mockResolvedValue("forced summary");

    const result = await forceCompact({
      messages, config: makeConfig(), model: dummyModel, apiKey: dummyApiKey,
    });

    expect(result.length).toBeLessThan(messages.length);
    expect(mockGenerateSummary).toHaveBeenCalledOnce();

    const summary = result[0] as unknown as { content: Array<{ type: string; text: string }> };
    expect(summary.content[0].text).toContain("[Previous conversation summary]");
    expect(summary.content[0].text).toContain("forced summary");
  });

  it("returns original messages when not enough to compact", async () => {
    const messages = makeMessages(2, 100);

    const result = await forceCompact({
      messages, config: makeConfig(), model: dummyModel, apiKey: dummyApiKey,
    });

    expect(result).toBe(messages);
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });

  it("throws when generateSummary fails", async () => {
    const messages = makeMessages(20, 100);
    mockGenerateSummary.mockRejectedValue(new Error("LLM error"));

    await expect(
      forceCompact({ messages, config: makeConfig(), model: dummyModel, apiKey: dummyApiKey }),
    ).rejects.toThrow("LLM error");
  });
});

// ---------------------------------------------------------------------------
// iterativeCompact
// ---------------------------------------------------------------------------

describe("iterativeCompact", () => {
  it("returns messages unchanged if already under threshold", async () => {
    const messages = makeMessages(5, 100);

    const result = await iterativeCompact({
      messages, config: makeConfig(), model: dummyModel, apiKey: dummyApiKey,
    });

    expect(result).toBe(messages);
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });

  it("performs multiple rounds until under threshold", async () => {
    const messages = makeMessages(100, 10_000);
    let callCount = 0;
    mockGenerateSummary.mockImplementation(() => {
      callCount++;
      return Promise.resolve(`Round ${callCount} summary - brief`);
    });

    const result = await iterativeCompact({
      messages,
      config: makeConfig({ contextWindow: 200_000, threshold: 0.5 }),
      model: dummyModel, apiKey: dummyApiKey,
      maxRounds: 3,
    });

    expect(mockGenerateSummary).toHaveBeenCalled();
    expect(result.length).toBeLessThan(messages.length);
  });

  it("stops at max rounds even if still over threshold", async () => {
    const messages = makeMessages(20, 50_000);
    mockGenerateSummary.mockResolvedValue("x".repeat(40_000));

    const result = await iterativeCompact({
      messages,
      config: makeConfig({ contextWindow: 10_000, threshold: 0.5 }),
      model: dummyModel, apiKey: dummyApiKey,
      maxRounds: 2,
    });

    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    expect(result.length).toBeLessThan(messages.length);
  });
});
