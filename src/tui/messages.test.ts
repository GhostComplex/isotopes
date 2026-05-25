import { describe, it, expect } from "vitest";
import { historyToTuiMessages, tuiMessage } from "./messages.js";

describe("historyToTuiMessages", () => {
  it("converts user and assistant messages", () => {
    const items = [
      { role: "user", content: "hi", timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2000 },
    ];
    const result = historyToTuiMessages(items);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toEqual(tuiMessage("user", "hi").content);
    expect(result[1].role).toBe("assistant");
    expect(result[1].content).toEqual(tuiMessage("assistant", "hello").content);
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
    expect(content[0].type === "tool" && content[0].completed).toBe(true);
    expect(content[1].type === "tool" && content[1].completed).toBe(true);
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
    expect(content[0].type === "tool" && content[0].completed).toBe(true);
  });

  it("splits consecutive assistant messages into separate entries", () => {
    const items = [
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "second" }] },
    ];
    const result = historyToTuiMessages(items);
    expect(result).toHaveLength(2);
    expect(result[0].content).toEqual(tuiMessage("assistant", "first").content);
    expect(result[1].content).toEqual(tuiMessage("assistant", "second").content);
  });

  it("handles user content as array of text items", () => {
    const items = [
      { role: "user", content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] },
    ];
    const result = historyToTuiMessages(items);
    expect(result[0].content).toEqual(tuiMessage("user", "hello world").content);
  });
});
