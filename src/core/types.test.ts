// src/core/types.test.ts — Unit tests for message helper functions

import { describe, it, expect } from "vitest";
import { userMessage, assistantMessage, toolResultMessage, messageText } from "./messages.js";

describe("userMessage", () => {
  it("creates a user message with string content", () => {
    const msg = userMessage("hello");
    expect(msg.role).toBe("user");
    expect((msg as { content: string }).content).toBe("hello");
  });

  it("sets timestamp", () => {
    const msg = userMessage("hi", 12345);
    expect((msg as { timestamp: number }).timestamp).toBe(12345);
  });
});

describe("assistantMessage", () => {
  it("creates an assistant message with text content block", () => {
    const msg = assistantMessage("hello");
    expect(msg.role).toBe("assistant");
    const content = (msg as { content: Array<{ type: string; text: string }> }).content;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toBe("hello");
  });
});

describe("toolResultMessage", () => {
  it("creates a toolResult message", () => {
    const msg = toolResultMessage("output", "call-1", "shell");
    expect(msg.role).toBe("toolResult");
    const m = msg as unknown as { content: Array<{ type: string; text: string }>; toolCallId: string; toolName: string };
    expect(m.content).toEqual([{ type: "text", text: "output" }]);
    expect(m.toolCallId).toBe("call-1");
    expect(m.toolName).toBe("shell");
  });
});

describe("messageText", () => {
  it("extracts text from string content", () => {
    expect(messageText(userMessage("hello"))).toBe("hello");
  });

  it("extracts text from array content blocks", () => {
    expect(messageText(assistantMessage("world"))).toBe("world");
  });

  it("returns empty for messages with no text content", () => {
    const msg = { role: "custom" } as unknown as Parameters<typeof messageText>[0];
    expect(messageText(msg)).toBe("");
  });
});
