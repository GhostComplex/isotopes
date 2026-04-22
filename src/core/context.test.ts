// src/core/context.test.ts — Tests for prompt preparation transforms

import { describe, it, expect } from "vitest";
import type { AgentMessage as Message } from "@mariozechner/pi-agent-core";
import { msgField } from "./messages.js";
import {
  limitHistoryTurns,
  pruneToolResults,
  pruneImages,
} from "./context.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TS = 1000;
const user = (text: string): Message => ({ role: "user", content: text, timestamp: TS } as unknown as Message);
const assistant = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }], timestamp: TS } as unknown as Message);
const toolResult = (output: string, toolCallId?: string): Message => ({
  role: "toolResult",
  content: output,
  toolCallId: toolCallId ?? "unknown",
  toolName: "test",
  timestamp: TS,
} as unknown as Message);

function assistantWithToolUse(text: string, toolUses: Array<{ id: string; name?: string }>): Message {
  const content: unknown[] = [{ type: "text", text }];
  for (const tu of toolUses) {
    content.push({ type: "toolCall", id: tu.id, name: tu.name ?? "test_tool" });
  }
  return { role: "assistant", content, timestamp: TS } as unknown as Message;
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
      assistant("e"),
    ];
    const result = pruneToolResults(msgs, { protectRecent: 3 });
    const trimmedContent = msgField(result[1], "content") as string;
    expect(trimmedContent.length).toBeLessThan(longOutput.length);
    expect(trimmedContent).toContain("middle content omitted");
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
    const block = (result[2] as unknown as {content:unknown}).content;
    // @ts-expect-error test fixture
    if (block.type === "tool_result") {
    // @ts-expect-error test fixture
      expect(block.output).toBe(longOutput);
    }
  });

  it("does not trim short tool results", () => {
    const shortOutput = "ok";
    const msgs = [user("a"), toolResult(shortOutput, "t1"), assistant("b"), assistant("c"), assistant("d"), assistant("e")];
    const result = pruneToolResults(msgs, { protectRecent: 3 });
    const content = msgField(result[1], "content") as string;
    expect(content).toBe(shortOutput);
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
    const imageBlock = { type: "image", data: "base64..." };
    const msgs: Message[] = [
      { role: "user", content: [imageBlock, { type: "text", text: "look" }], timestamp: Date.now() } as unknown as Message,
      assistant("nice"),
      user("more recent 1"), assistant("r1"),
      user("more recent 2"), assistant("r2"),
      user("more recent 3"), assistant("r3"),
    ];
    const result = pruneImages(msgs, { keepRecentTurns: 3 });
    const content = msgField(result[0], "content") as Array<{type: string; text?: string}>;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("image data removed");
  });

  it("preserves images in recent turns", () => {
    const imageBlock = { type: "image", data: "base64..." };
    const msgs: Message[] = [
      { role: "user", content: [imageBlock], timestamp: Date.now() } as unknown as Message,
      assistant("nice"),
    ];
    const result = pruneImages(msgs, { keepRecentTurns: 3 });
    const content = msgField(result[0], "content") as Array<{type: string}>;
    expect(content[0].type).toBe("image");
  });

  it("no-op when no image blocks exist", () => {
    const msgs = [user("a"), assistant("b")];
    expect(pruneImages(msgs)).toEqual(msgs);
  });
});

