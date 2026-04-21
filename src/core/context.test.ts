// src/core/context.test.ts — Tests for prompt preparation transforms

import { describe, it, expect } from "vitest";
import { textContent, type Message } from "./types.js";
import {
  limitHistoryTurns,
  sanitizeToolUseResultPairing,
  pruneToolResults,
  pruneImages,
  preparePromptMessages,
} from "./context.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const user = (text: string): Message => ({ role: "user", content: textContent(text) });
const assistant = (text: string): Message => ({ role: "assistant", content: textContent(text) });
const toolResult = (output: string, toolCallId?: string): Message => ({
  role: "tool_result",
  content: [{ type: "tool_result", output, toolCallId }],
  metadata: toolCallId ? { toolCallId } : undefined,
});

/** Assistant message with tool_use blocks (runtime duck-typed, not in our TS union) */
function assistantWithToolUse(text: string, toolUses: Array<{ id: string; name?: string }>): Message {
  const content: unknown[] = [{ type: "text", text }];
  for (const tu of toolUses) {
    content.push({ type: "tool_use", id: tu.id, name: tu.name ?? "test_tool" });
  }
  return { role: "assistant", content: content as Message["content"] };
}

// ---------------------------------------------------------------------------
// limitHistoryTurns
// ---------------------------------------------------------------------------

describe("limitHistoryTurns", () => {
  it("returns all messages when under the limit", () => {
    const msgs = [user("a"), assistant("b"), user("c"), assistant("d")];
    expect(limitHistoryTurns(msgs, 10)).toEqual(msgs);
  });

  it("returns all messages when exactly at limit", () => {
    const msgs = [user("a"), assistant("b"), user("c"), assistant("d")];
    expect(limitHistoryTurns(msgs, 2)).toEqual(msgs);
  });

  it("truncates to last N user turns", () => {
    const msgs = [
      user("turn1"), assistant("r1"),
      user("turn2"), assistant("r2"),
      user("turn3"), assistant("r3"),
    ];
    const result = limitHistoryTurns(msgs, 2);
    expect(result).toEqual([
      user("turn2"), assistant("r2"),
      user("turn3"), assistant("r3"),
    ]);
  });

  it("keeps assistant and tool messages in each turn", () => {
    const msgs = [
      user("a"), assistant("b"),
      user("c"), assistantWithToolUse("d", [{ id: "t1" }]), toolResult("ok", "t1"), assistant("e"),
      user("f"), assistant("g"),
    ];
    const result = limitHistoryTurns(msgs, 2);
    expect(result[0]).toEqual(user("c"));
    expect(result.length).toBe(6);
  });

  it("always starts with a user message", () => {
    const msgs = [
      assistant("orphan"),
      user("a"), assistant("b"),
      user("c"), assistant("d"),
    ];
    const result = limitHistoryTurns(msgs, 1);
    expect(result[0].role).toBe("user");
    expect(result).toEqual([user("c"), assistant("d")]);
  });

  it("returns empty array for empty input", () => {
    expect(limitHistoryTurns([], 5)).toEqual([]);
  });

  it("returns all messages for limit <= 0", () => {
    const msgs = [user("a"), assistant("b")];
    expect(limitHistoryTurns(msgs, 0)).toEqual(msgs);
    expect(limitHistoryTurns(msgs, -1)).toEqual(msgs);
  });
});

// ---------------------------------------------------------------------------
// sanitizeToolUseResultPairing
// ---------------------------------------------------------------------------

describe("sanitizeToolUseResultPairing", () => {
  it("drops orphaned leading tool_result messages", () => {
    const msgs = [
      toolResult("orphaned", "t0"),
      toolResult("also orphaned", "t1"),
      user("hello"),
      assistant("hi"),
    ];
    const result = sanitizeToolUseResultPairing(msgs);
    expect(result).toEqual([user("hello"), assistant("hi")]);
  });

  it("inserts synthetic tool_result for unmatched tool_use", () => {
    const msgs = [
      user("do it"),
      assistantWithToolUse("calling", [{ id: "t1", name: "read_file" }]),
      // no tool_result for t1
      user("next"),
    ];
    const result = sanitizeToolUseResultPairing(msgs);
    expect(result.length).toBe(4); // user, assistant, synthetic tool_result, user
    const synthetic = result[2];
    expect(synthetic.role).toBe("tool_result");
    expect(synthetic.metadata?.synthetic).toBe(true);
    expect(synthetic.metadata?.toolCallId).toBe("t1");
  });

  it("does not insert synthetic when tool_result exists", () => {
    const msgs = [
      user("do it"),
      assistantWithToolUse("calling", [{ id: "t1" }]),
      toolResult("done", "t1"),
      user("next"),
    ];
    const result = sanitizeToolUseResultPairing(msgs);
    expect(result).toEqual(msgs);
  });

  it("recognizes the tool_call block shape (our persisted format) for orphan synthesis", () => {
    const msgs: Message[] = [
      user("do it"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool_call", id: "t1", name: "read_file", input: { path: "/x" } },
        ],
      },
      // no tool_result for t1 — session truncated mid-turn
      user("next"),
    ];
    const result = sanitizeToolUseResultPairing(msgs);
    expect(result.length).toBe(4);
    expect(result[2].role).toBe("tool_result");
    expect(result[2].metadata?.toolCallId).toBe("t1");
    expect(result[2].metadata?.synthetic).toBe(true);
  });

  it("handles multiple tool_use blocks in one assistant message", () => {
    const msgs = [
      user("do both"),
      assistantWithToolUse("calling two", [{ id: "t1" }, { id: "t2" }]),
      toolResult("ok1", "t1"),
      // t2 missing
    ];
    const result = sanitizeToolUseResultPairing(msgs);
    // Result: user, assistant, synthetic(t2), toolResult(t1)
    expect(result.length).toBe(4);
    expect(result[2].role).toBe("tool_result");
    expect(result[2].metadata?.toolCallId).toBe("t2");
    expect(result[2].metadata?.synthetic).toBe(true);
    // The real t1 result is preserved
    expect(result[3].role).toBe("tool_result");
    const t1Block = result[3].content[0];
    expect(t1Block.type === "tool_result" && t1Block.output === "ok1").toBe(true);
  });

  it("no-op for clean messages", () => {
    const msgs = [user("a"), assistant("b"), user("c"), assistant("d")];
    expect(sanitizeToolUseResultPairing(msgs)).toEqual(msgs);
  });

  it("returns empty for empty input", () => {
    expect(sanitizeToolUseResultPairing([])).toEqual([]);
  });

  it("returns empty when all messages are orphaned tool_results", () => {
    const msgs = [toolResult("a", "t1"), toolResult("b", "t2")];
    expect(sanitizeToolUseResultPairing(msgs)).toEqual([]);
  });

  it("handles tool_result with empty content array without throwing", () => {
    const emptyContentResult: Message = {
      role: "tool_result",
      content: [] as unknown as Message["content"],
      metadata: { toolCallId: "t1" },
    };
    const msgs = [
      user("do it"),
      assistantWithToolUse("calling", [{ id: "t1" }]),
      emptyContentResult,
      user("next"),
    ];
    // Should not throw — and should find the toolCallId via metadata fallback
    const result = sanitizeToolUseResultPairing(msgs);
    expect(result.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// pruneToolResults
// ---------------------------------------------------------------------------

describe("pruneToolResults", () => {
  it("trims long tool results outside protection zone", () => {
    const longOutput = "x".repeat(5000);
    const msgs = [
      user("a"),
      toolResult(longOutput, "t1"),
      assistant("b"),
      assistant("c"),
      assistant("d"),
      assistant("e"), // 3 recent assistants = protected zone starts at d
    ];
    const result = pruneToolResults(msgs, { protectRecent: 3 });
    const trimmedBlock = result[1].content[0];
    expect(trimmedBlock.type).toBe("tool_result");
    if (trimmedBlock.type === "tool_result") {
      expect(trimmedBlock.output.length).toBeLessThan(longOutput.length);
      expect(trimmedBlock.output).toContain("...[trimmed]...");
    }
  });

  it("does not trim tool results in protected zone", () => {
    const longOutput = "x".repeat(5000);
    const msgs = [
      user("a"),
      assistant("b"),
      toolResult(longOutput, "t1"), // within last 3 assistant messages
      assistant("c"),
    ];
    const result = pruneToolResults(msgs, { protectRecent: 3 });
    const block = result[2].content[0];
    if (block.type === "tool_result") {
      expect(block.output).toBe(longOutput);
    }
  });

  it("does not trim short tool results", () => {
    const shortOutput = "ok";
    const msgs = [user("a"), toolResult(shortOutput, "t1"), assistant("b"), assistant("c"), assistant("d"), assistant("e")];
    const result = pruneToolResults(msgs, { protectRecent: 3 });
    const block = result[1].content[0];
    if (block.type === "tool_result") {
      expect(block.output).toBe(shortOutput);
    }
  });

  it("no-op for messages without tool results", () => {
    const msgs = [user("a"), assistant("b")];
    expect(pruneToolResults(msgs)).toEqual(msgs);
  });
});

// ---------------------------------------------------------------------------
// pruneImages
// ---------------------------------------------------------------------------

describe("pruneImages", () => {
  it("replaces old image blocks with text placeholder", () => {
    const imageBlock = { type: "image" as const, data: "base64..." };
    const msgs: Message[] = [
      { role: "user", content: [imageBlock as unknown as Message["content"][0], { type: "text", text: "look" }] },
      assistant("nice"),
      user("more recent 1"), assistant("r1"),
      user("more recent 2"), assistant("r2"),
      user("more recent 3"), assistant("r3"),
    ];
    const result = pruneImages(msgs, { keepRecentTurns: 3 });
    const block = result[0].content[0];
    expect(block.type).toBe("text");
    if (block.type === "text") {
      expect(block.text).toContain("image data removed");
    }
  });

  it("preserves images in recent turns", () => {
    const imageBlock = { type: "image" as const, data: "base64..." };
    const msgs: Message[] = [
      { role: "user", content: [imageBlock as unknown as Message["content"][0]] },
      assistant("nice"),
    ];
    const result = pruneImages(msgs, { keepRecentTurns: 3 });
    expect((result[0].content[0] as unknown as Record<string, unknown>).type).toBe("image");
  });

  it("no-op when no image blocks exist", () => {
    const msgs = [user("a"), assistant("b")];
    expect(pruneImages(msgs)).toEqual(msgs);
  });
});

// ---------------------------------------------------------------------------
// preparePromptMessages (integration)
// ---------------------------------------------------------------------------

describe("preparePromptMessages", () => {
  it("chains all transforms", () => {
    const msgs = [
      user("turn1"), assistant("r1"),
      user("turn2"), assistant("r2"),
      user("turn3"), assistant("r3"),
    ];
    const result = preparePromptMessages(msgs, { historyTurns: 2 });
    expect(result[0]).toEqual(user("turn2"));
    expect(result.length).toBe(4);
  });

  it("fixes orphaned tool_results after truncation", () => {
    const msgs = [
      user("a"), assistantWithToolUse("b", [{ id: "t1" }]), toolResult("ok", "t1"),
      user("c"), assistant("d"),
    ];
    // Truncate to 1 turn → keeps only [user("c"), assistant("d")]
    const result = preparePromptMessages(msgs, { historyTurns: 1 });
    expect(result[0]).toEqual(user("c"));
    expect(result.length).toBe(2);
  });

  it("uses default options when none provided", () => {
    const msgs = [user("a"), assistant("b")];
    const result = preparePromptMessages(msgs);
    expect(result).toEqual(msgs);
  });
});
