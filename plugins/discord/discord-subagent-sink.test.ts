// src/subagent/discord-sink.test.ts — Tests for Discord sink formatters
import { describe, it, expect, vi } from "vitest";
import { truncate, formatEvent, formatSummary, DiscordSink } from "./discord-subagent-sink.js";
import type { SubagentEvent, SubagentResult, DiscordSinkConfig } from "../subagent/types.js";

const showAll: DiscordSinkConfig = { showToolCalls: true, showThinking: false, useThread: false };
const hideTools: DiscordSinkConfig = { showToolCalls: false, showThinking: false, useThread: false };

describe("truncate", () => {
  it("leaves short strings alone", () => {
    expect(truncate("hi", 10)).toBe("hi");
  });

  it("clips and appends ellipsis", () => {
    expect(truncate("0123456789", 8)).toBe("01234...");
  });
});

describe("formatEvent", () => {
  it("returns undefined for start/done (handled separately)", () => {
    expect(formatEvent({ type: "start" }, showAll)).toBeUndefined();
    expect(formatEvent({ type: "done", exitCode: 0 }, showAll)).toBeUndefined();
  });

  it("formats message content", () => {
    expect(formatEvent({ type: "message", content: "hello" }, showAll)).toBe("hello");
  });

  it("drops empty message", () => {
    expect(formatEvent({ type: "message" }, showAll)).toBeUndefined();
  });

  it("formats tool_use when enabled, hides when disabled", () => {
    const ev: SubagentEvent = { type: "tool_use", toolName: "Read" };
    expect(formatEvent(ev, showAll)).toContain("Read");
    expect(formatEvent(ev, hideTools)).toBeUndefined();
  });

  it("formats tool_result when enabled", () => {
    const ev: SubagentEvent = { type: "tool_result", toolName: "Read", toolResult: "file content" };
    const out = formatEvent(ev, showAll)!;
    expect(out).toContain("Read");
    expect(out).toContain("file content");
  });

  it("formats errors", () => {
    expect(formatEvent({ type: "error", error: "boom" }, showAll)).toContain("boom");
  });
});

describe("formatSummary", () => {
  const baseResult: SubagentResult = {
    success: true,
    events: [],
    exitCode: 0,
  };

  it("shows success with exit code label", () => {
    expect(formatSummary(baseResult)).toContain("✅");
    expect(formatSummary(baseResult)).toContain("success");
  });

  it("shows failure with error subtype label", () => {
    const out = formatSummary({ ...baseResult, success: false, exitCode: 1 });
    expect(out).toContain("❌");
    expect(out).toContain("API error");
  });

  it("includes message/tool counts", () => {
    const out = formatSummary({
      ...baseResult,
      events: [
        { type: "message", content: "a" },
        { type: "message", content: "b" },
        { type: "tool_use", toolName: "Read" },
      ],
    });
    expect(out).toContain("2 messages");
    expect(out).toContain("1 tool call");
  });

  it("includes duration and cost", () => {
    const out = formatSummary({ ...baseResult, durationMs: 3500, costUsd: 0.1234 });
    expect(out).toContain("4s");
    expect(out).toContain("$0.1234");
  });

  it("includes thread link when provided", () => {
    const out = formatSummary(baseResult, "thread-123");
    expect(out).toContain("<#thread-123>");
  });
});

describe("DiscordSink", () => {
  it("creates thread when useThread=true and sends summary to main channel", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ id: "msg-1" });
    const createThread = vi.fn().mockResolvedValue({ id: "thread-1" });

    const sink = new DiscordSink(sendMessage, createThread, "main-ch", {
      showToolCalls: true,
      showThinking: false,
      useThread: true,
    });

    await sink.start("task");
    expect(createThread).toHaveBeenCalledWith("main-ch", "task", "msg-1");
    expect(sink.getThreadId()).toBe("thread-1");

    await sink.sendEvent({ type: "message", content: "hi" });
    // event was sent to thread target
    expect(sendMessage).toHaveBeenCalledWith("thread-1", "hi");

    await sink.finish({ success: true, events: [], exitCode: 0 });
    // summary to main channel, not thread
    expect(sendMessage).toHaveBeenCalledWith("main-ch", expect.stringContaining("✅"));
  });

  it("skips thread creation when useThread=false", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ id: "msg-1" });
    const createThread = vi.fn();
    const sink = new DiscordSink(sendMessage, createThread, "ch", {
      showToolCalls: true,
      showThinking: false,
      useThread: false,
    });
    await sink.start("t");
    expect(createThread).not.toHaveBeenCalled();
    expect(sink.getThreadId()).toBeUndefined();
  });
});
