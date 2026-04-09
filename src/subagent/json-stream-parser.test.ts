// src/subagent/json-stream-parser.test.ts — Unit tests for JSON stream parser

import { describe, it, expect } from "vitest";
import { JsonStreamParser } from "./json-stream-parser.js";

describe("JsonStreamParser", () => {
  it("parses a complete single-line JSON event", () => {
    const parser = new JsonStreamParser();
    const events = parser.push('{"type":"assistant","content":"Hello"}\n');

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "assistant_message",
      content: "Hello",
    });
  });

  it("parses multiple events in a single chunk", () => {
    const parser = new JsonStreamParser();
    const events = parser.push(
      '{"type":"assistant","content":"Hello "}\n{"type":"assistant","content":"world!"}\n',
    );

    expect(events).toHaveLength(2);
    expect(events[0].content).toBe("Hello ");
    expect(events[1].content).toBe("world!");
  });

  it("handles partial lines across chunks", () => {
    const parser = new JsonStreamParser();

    // First chunk: incomplete line
    const events1 = parser.push('{"type":"assist');
    expect(events1).toHaveLength(0);

    // Second chunk: completes the line
    const events2 = parser.push('ant","content":"Hi"}\n');
    expect(events2).toHaveLength(1);
    expect(events2[0]).toEqual({
      type: "assistant_message",
      content: "Hi",
    });
  });

  it("flushes remaining buffered data", () => {
    const parser = new JsonStreamParser();

    // Push without trailing newline
    parser.push('{"type":"assistant","content":"Final"}');
    const events = parser.flush();

    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("Final");
  });

  it("skips empty lines", () => {
    const parser = new JsonStreamParser();
    const events = parser.push('\n\n{"type":"assistant","content":"X"}\n\n');

    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("X");
  });

  it("skips invalid JSON lines", () => {
    const parser = new JsonStreamParser();
    const events = parser.push(
      'not json\n{"type":"assistant","content":"OK"}\n{broken\n',
    );

    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("OK");
  });

  it("skips events with unknown type", () => {
    const parser = new JsonStreamParser();
    const events = parser.push('{"type":"unknown_event","data":"x"}\n');

    expect(events).toHaveLength(0);
  });

  it("skips events without a type field", () => {
    const parser = new JsonStreamParser();
    const events = parser.push('{"content":"no type"}\n');

    expect(events).toHaveLength(0);
  });

  it("parses tool_use events", () => {
    const parser = new JsonStreamParser();
    const events = parser.push(
      '{"type":"tool_use","tool_name":"shell","tool_input":{"command":"ls"}}\n',
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "tool_use",
      toolName: "shell",
      toolInput: { command: "ls" },
    });
  });

  it("parses tool_result events", () => {
    const parser = new JsonStreamParser();
    const events = parser.push(
      '{"type":"tool_result","tool_result":"file1.txt\\nfile2.txt"}\n',
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "tool_result",
      toolResult: "file1.txt\nfile2.txt",
    });
  });

  it("parses thinking events", () => {
    const parser = new JsonStreamParser();
    const events = parser.push(
      '{"type":"thinking","content":"Let me analyze..."}\n',
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "thinking",
      content: "Let me analyze...",
    });
  });

  it("parses error events", () => {
    const parser = new JsonStreamParser();
    const events = parser.push(
      '{"type":"error","error":"Rate limit exceeded"}\n',
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      error: "Rate limit exceeded",
    });
  });

  it("parses done/result events", () => {
    const parser = new JsonStreamParser();
    const events = parser.push('{"type":"result"}\n');

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "done" });
  });

  it("parses message_stop events as done", () => {
    const parser = new JsonStreamParser();
    const events = parser.push('{"type":"message_stop"}\n');

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("done");
  });

  it("handles multiple flushes gracefully", () => {
    const parser = new JsonStreamParser();

    // Flush with nothing buffered
    expect(parser.flush()).toHaveLength(0);
    expect(parser.flush()).toHaveLength(0);

    // Push, flush, then flush again
    parser.push('{"type":"assistant","content":"A"}');
    expect(parser.flush()).toHaveLength(1);
    expect(parser.flush()).toHaveLength(0);
  });

  it("handles interleaved event types", () => {
    const parser = new JsonStreamParser();
    const events = parser.push(
      [
        '{"type":"thinking","content":"planning..."}',
        '{"type":"assistant","content":"Here is the fix:"}',
        '{"type":"tool_use","tool_name":"write_file","tool_input":{"path":"a.ts"}}',
        '{"type":"tool_result","tool_result":"OK"}',
        '{"type":"result"}',
      ].join("\n") + "\n",
    );

    expect(events).toHaveLength(5);
    expect(events.map((e) => e.type)).toEqual([
      "thinking",
      "assistant_message",
      "tool_use",
      "tool_result",
      "done",
    ]);
  });
});
