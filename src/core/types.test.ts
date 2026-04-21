// src/core/types.test.ts — Unit tests for type utility functions

import { describe, it, expect } from "vitest";
import { textContent, messageContentToPlainText } from "./types.js";
import type { MessageContentBlock } from "./types.js";

describe("textContent", () => {
  it("wraps a string into a single text content block array", () => {
    const result = textContent("hello");

    expect(result).toEqual([{ type: "text", text: "hello" }]);
  });

  it("returns an array with one element", () => {
    expect(textContent("anything")).toHaveLength(1);
  });

  it("handles empty string", () => {
    const result = textContent("");

    expect(result).toEqual([{ type: "text", text: "" }]);
  });

  it("preserves special characters and newlines", () => {
    const text = 'line1\nline2\t"quoted" & <tagged>';
    const result = textContent(text);
    const block = result[0] as { type: "text"; text: string };

    expect(block.text).toBe(text);
  });
});

describe("messageContentToPlainText", () => {
  it("extracts text from text blocks", () => {
    const blocks: MessageContentBlock[] = [
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ];

    expect(messageContentToPlainText(blocks)).toBe("Hello\nWorld");
  });

  it("extracts output from tool_result blocks", () => {
    const blocks: MessageContentBlock[] = [
      { type: "tool_result", output: "42" },
    ];

    expect(messageContentToPlainText(blocks)).toBe("42");
  });

  it("handles mixed text and tool_result blocks", () => {
    const blocks: MessageContentBlock[] = [
      { type: "text", text: "The answer is:" },
      { type: "tool_result", output: "42" },
    ];

    expect(messageContentToPlainText(blocks)).toBe("The answer is:\n42");
  });

  it("returns empty string for empty array", () => {
    expect(messageContentToPlainText([])).toBe("");
  });

  it("handles single text block without trailing newline", () => {
    const blocks: MessageContentBlock[] = [
      { type: "text", text: "only text" },
    ];

    expect(messageContentToPlainText(blocks)).toBe("only text");
  });

  it("renders tool_call blocks as [tool: name]", () => {
    const blocks: MessageContentBlock[] = [
      { type: "text", text: "Let me check." },
      { type: "tool_call", id: "c1", name: "shell", input: { cmd: "ls" } },
    ];

    expect(messageContentToPlainText(blocks)).toBe("Let me check.\n[tool: shell]");
  });
});
