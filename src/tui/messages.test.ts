import { describe, it, expect } from "vitest";
import { historyToTuiMessages, extractResultText, toContent } from "./messages.js";

describe("extractResultText", () => {
  it("returns string as-is", () => {
    expect(extractResultText("hello")).toBe("hello");
  });

  it("joins text items from array", () => {
    const items = [
      { type: "text", text: "line1" },
      { type: "text", text: "line2" },
    ];
    expect(extractResultText(items)).toBe("line1\nline2");
  });

  it("unwraps content property", () => {
    expect(extractResultText({ content: "nested" })).toBe("nested");
  });

  it("JSON stringifies unknown shapes", () => {
    expect(extractResultText(42)).toBe("42");
  });
});

describe("historyToTuiMessages", () => {
  it("converts user and assistant messages", () => {
    const items = [
      { role: "user", content: "hi", timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2000 },
    ];
    const result = historyToTuiMessages(items);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toEqual(toContent("hi"));
    expect(result[1].role).toBe("assistant");
    expect(result[1].content).toEqual(toContent("hello"));
  });

  it("skips empty user messages", () => {
    const items = [
      { role: "user", content: [] },
      { role: "assistant", content: [{ type: "text", text: "response" }] },
    ];
    const result = historyToTuiMessages(items);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
  });

  it("strips steer prefix from user messages", () => {
    const items = [
      { role: "user", content: "[Messages arrived while you were working]\nactual message" },
    ];
    const result = historyToTuiMessages(items);
    expect(result[0].content).toEqual(toContent("actual message"));
  });

  it("marks toolResult by toolCallId before flush", () => {
    const items = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "t1", name: "echo", arguments: "{}" },
          { type: "toolCall", id: "t2", name: "time", arguments: "{}" },
        ],
      },
      { role: "toolResult", toolCallId: "t2" },
      { role: "toolResult", toolCallId: "t1" },
    ];
    const result = historyToTuiMessages(items);
    expect(result).toHaveLength(1);
    const content = result[0].content;
    expect(content[0].type === "tool" && content[0].result).toBe("✓");
    expect(content[1].type === "tool" && content[1].result).toBe("✓");
  });

  it("falls back to first-unresolved when no toolCallId", () => {
    const items = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "t1", name: "echo", arguments: "{}" },
        ],
      },
      { role: "toolResult" },
    ];
    const result = historyToTuiMessages(items);
    const content = result[0].content;
    expect(content[0].type === "tool" && content[0].result).toBe("✓");
  });

  it("splits consecutive assistant messages into separate entries", () => {
    const items = [
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "second" }] },
    ];
    const result = historyToTuiMessages(items);
    expect(result).toHaveLength(2);
    expect(result[0].content).toEqual(toContent("first"));
    expect(result[1].content).toEqual(toContent("second"));
  });

  it("handles user content as array of text items", () => {
    const items = [
      { role: "user", content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] },
    ];
    const result = historyToTuiMessages(items);
    expect(result[0].content).toEqual(toContent("hello world"));
  });
});
