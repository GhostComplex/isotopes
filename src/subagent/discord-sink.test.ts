// src/subagent/discord-sink.test.ts — Unit tests for DiscordSink

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DiscordSink,
  truncate,
  formatEvent,
  formatSummary,
} from "./discord-sink.js";
import type { AcpxResult, DiscordSinkConfig } from "./types.js";

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("hello")).toBe("hello");
  });

  it("truncates strings exceeding maxLen", () => {
    const long = "a".repeat(2000);
    const result = truncate(long, 100);
    expect(result.length).toBe(100);
    expect(result.endsWith("...")).toBe(true);
  });

  it("uses default max length of 1900", () => {
    const long = "a".repeat(2000);
    const result = truncate(long);
    expect(result.length).toBe(1900);
    expect(result.endsWith("...")).toBe(true);
  });

  it("returns exact-length strings unchanged", () => {
    const exact = "a".repeat(100);
    expect(truncate(exact, 100)).toBe(exact);
  });

  it("handles empty strings", () => {
    expect(truncate("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// formatEvent
// ---------------------------------------------------------------------------

describe("formatEvent", () => {
  const configWithTools: DiscordSinkConfig = {
    showToolCalls: true,
    showThinking: false,
    useThread: true,
  };

  const configWithoutTools: DiscordSinkConfig = {
    showToolCalls: false,
    showThinking: false,
    useThread: true,
  };

  it("returns undefined for start events", () => {
    expect(formatEvent({ type: "start" }, configWithTools)).toBeUndefined();
  });

  it("returns undefined for done events", () => {
    expect(formatEvent({ type: "done", exitCode: 0 }, configWithTools)).toBeUndefined();
  });

  it("formats message events with content", () => {
    const result = formatEvent({ type: "message", content: "Hello" }, configWithTools);
    expect(result).toBe("Hello");
  });

  it("returns undefined for message events without content", () => {
    expect(formatEvent({ type: "message" }, configWithTools)).toBeUndefined();
  });

  it("formats tool_use events when showToolCalls is true", () => {
    const result = formatEvent(
      { type: "tool_use", toolName: "shell" },
      configWithTools,
    );
    expect(result).toContain("shell");
    expect(result).toContain("🔧");
  });

  it("returns undefined for tool_use events when showToolCalls is false", () => {
    expect(
      formatEvent({ type: "tool_use", toolName: "shell" }, configWithoutTools),
    ).toBeUndefined();
  });

  it("formats tool_result events when showToolCalls is true", () => {
    const result = formatEvent(
      { type: "tool_result", toolName: "shell", toolResult: "output.txt" },
      configWithTools,
    );
    expect(result).toContain("shell");
    expect(result).toContain("output.txt");
    expect(result).toContain("📋");
  });

  it("returns undefined for tool_result events when showToolCalls is false", () => {
    expect(
      formatEvent(
        { type: "tool_result", toolName: "shell", toolResult: "output" },
        configWithoutTools,
      ),
    ).toBeUndefined();
  });

  it("formats error events", () => {
    const result = formatEvent(
      { type: "error", error: "Something failed" },
      configWithTools,
    );
    expect(result).toContain("Something failed");
    expect(result).toContain("❌");
  });

  it("handles error events without error text", () => {
    const result = formatEvent({ type: "error" }, configWithTools);
    expect(result).toContain("Unknown error");
  });

  it("handles tool_use without toolName", () => {
    const result = formatEvent({ type: "tool_use" }, configWithTools);
    expect(result).toContain("tool");
  });

  it("handles tool_result without toolResult", () => {
    const result = formatEvent({ type: "tool_result", toolName: "test" }, configWithTools);
    expect(result).toContain("(no output)");
  });

  it("truncates long message content", () => {
    const longContent = "a".repeat(2000);
    const result = formatEvent(
      { type: "message", content: longContent },
      configWithTools,
    );
    expect(result!.length).toBeLessThanOrEqual(1900);
  });

  it("truncates long error messages", () => {
    const longError = "e".repeat(2000);
    const result = formatEvent(
      { type: "error", error: longError },
      configWithTools,
    );
    expect(result!.length).toBeLessThanOrEqual(1900);
  });
});

// ---------------------------------------------------------------------------
// formatSummary
// ---------------------------------------------------------------------------

describe("formatSummary", () => {
  it("shows success status with exit code 0", () => {
    const result: AcpxResult = {
      success: true,
      events: [{ type: "done", exitCode: 0 }],
      exitCode: 0,
    };
    const summary = formatSummary(result);
    expect(summary).toContain("✅ Completed");
    expect(summary).toContain("exit code: 0");
  });

  it("shows failed status with non-zero exit code", () => {
    const result: AcpxResult = {
      success: false,
      events: [{ type: "done", exitCode: 1 }],
      exitCode: 1,
    };
    const summary = formatSummary(result);
    expect(summary).toContain("❌ Failed");
    expect(summary).toContain("exit code: 1");
  });

  it("includes message count", () => {
    const result: AcpxResult = {
      success: true,
      events: [
        { type: "message", content: "a" },
        { type: "message", content: "b" },
        { type: "done", exitCode: 0 },
      ],
      exitCode: 0,
    };
    const summary = formatSummary(result);
    expect(summary).toContain("2 messages");
  });

  it("includes tool call count", () => {
    const result: AcpxResult = {
      success: true,
      events: [
        { type: "tool_use", toolName: "shell" },
        { type: "done", exitCode: 0 },
      ],
      exitCode: 0,
    };
    const summary = formatSummary(result);
    expect(summary).toContain("1 tool call");
  });

  it("uses singular form for single message", () => {
    const result: AcpxResult = {
      success: true,
      events: [
        { type: "message", content: "hi" },
        { type: "done", exitCode: 0 },
      ],
      exitCode: 0,
    };
    const summary = formatSummary(result);
    expect(summary).toContain("1 message");
    expect(summary).not.toContain("1 messages");
  });

  it("includes error text when present", () => {
    const result: AcpxResult = {
      success: false,
      error: "Something broke",
      events: [{ type: "done", exitCode: 1 }],
      exitCode: 1,
    };
    const summary = formatSummary(result);
    expect(summary).toContain("Error: Something broke");
  });

  it("truncates long error text in summary", () => {
    const result: AcpxResult = {
      success: false,
      error: "e".repeat(1000),
      events: [{ type: "done", exitCode: 1 }],
      exitCode: 1,
    };
    const summary = formatSummary(result);
    expect(summary).toContain("...");
  });

  it("handles result with no messages or tools", () => {
    const result: AcpxResult = {
      success: true,
      events: [{ type: "start" }, { type: "done", exitCode: 0 }],
      exitCode: 0,
    };
    const summary = formatSummary(result);
    expect(summary).toContain("✅ Completed");
    // Should not contain message/tool counts
    expect(summary).not.toContain("message");
    expect(summary).not.toContain("tool");
  });

  it("includes thread link when threadId is provided", () => {
    const result: AcpxResult = {
      success: true,
      events: [{ type: "done", exitCode: 0 }],
      exitCode: 0,
    };
    const summary = formatSummary(result, "thread-123");
    expect(summary).toContain("<#thread-123>");
    expect(summary).toContain("Details");
  });

  it("does not include thread link when threadId is not provided", () => {
    const result: AcpxResult = {
      success: true,
      events: [{ type: "done", exitCode: 0 }],
      exitCode: 0,
    };
    const summary = formatSummary(result);
    expect(summary).not.toContain("<#");
    expect(summary).not.toContain("Details");
  });

  it("includes duration when durationMs is provided", () => {
    const result: AcpxResult = {
      success: true,
      events: [{ type: "done", exitCode: 0 }],
      exitCode: 0,
      durationMs: 45000,
    };
    const summary = formatSummary(result);
    expect(summary).toContain("45s");
  });

  it("includes cost when costUsd is provided", () => {
    const result: AcpxResult = {
      success: true,
      events: [{ type: "done", exitCode: 0 }],
      exitCode: 0,
      costUsd: 0.0123,
    };
    const summary = formatSummary(result);
    expect(summary).toContain("$0.0123");
  });

  it("includes all stats in one line", () => {
    const result: AcpxResult = {
      success: true,
      events: [
        { type: "message", content: "hi" },
        { type: "tool_use", toolName: "shell" },
        { type: "done", exitCode: 0 },
      ],
      exitCode: 0,
      durationMs: 30000,
      costUsd: 0.05,
    };
    const summary = formatSummary(result);
    expect(summary).toContain("1 message");
    expect(summary).toContain("1 tool call");
    expect(summary).toContain("30s");
    expect(summary).toContain("$0.0500");
  });
});

// ---------------------------------------------------------------------------
// DiscordSink
// ---------------------------------------------------------------------------

describe("DiscordSink", () => {
  let sendMessage: ReturnType<typeof vi.fn>;
  let createThread: ReturnType<typeof vi.fn>;
  let sink: DiscordSink;

  const defaultConfig: DiscordSinkConfig = {
    showToolCalls: true,
    showThinking: false,
    useThread: true,
  };

  beforeEach(() => {
    sendMessage = vi.fn().mockResolvedValue({ id: "msg-1" });
    createThread = vi.fn().mockResolvedValue({ id: "thread-1" });
    sink = new DiscordSink(sendMessage, createThread, "channel-1", defaultConfig);
  });

  describe("start", () => {
    it("sends an initial message to the channel", async () => {
      await sink.start("test task");

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(
        "channel-1",
        expect.stringContaining("test task"),
      );
    });

    it("creates a thread when useThread is true", async () => {
      await sink.start("test task");

      expect(createThread).toHaveBeenCalledTimes(1);
      expect(createThread).toHaveBeenCalledWith(
        "channel-1",
        expect.any(String),
        "msg-1",
      );
    });

    it("does not create a thread when useThread is false", async () => {
      const noThreadSink = new DiscordSink(
        sendMessage,
        createThread,
        "channel-1",
        { ...defaultConfig, useThread: false },
      );

      await noThreadSink.start("test task");

      expect(createThread).not.toHaveBeenCalled();
    });

    it("updates targetChannelId to thread after creation", async () => {
      await sink.start("test task");

      expect(sink.getTargetChannelId()).toBe("thread-1");
      expect(sink.getThreadId()).toBe("thread-1");
    });

    it("keeps original channel when no thread is created", async () => {
      const noThreadSink = new DiscordSink(
        sendMessage,
        createThread,
        "channel-1",
        { ...defaultConfig, useThread: false },
      );

      await noThreadSink.start("test task");

      expect(noThreadSink.getTargetChannelId()).toBe("channel-1");
      expect(noThreadSink.getThreadId()).toBeUndefined();
    });

    it("handles sendMessage errors gracefully", async () => {
      sendMessage.mockRejectedValueOnce(new Error("Discord API error"));

      // Should not throw
      await sink.start("test task");
    });

    it("truncates long task names for thread name", async () => {
      const longName = "a".repeat(200);
      await sink.start(longName);

      expect(createThread).toHaveBeenCalledWith(
        "channel-1",
        expect.any(String),
        "msg-1",
      );

      // Thread name should be truncated
      const threadName = createThread.mock.calls[0][1] as string;
      expect(threadName.length).toBeLessThanOrEqual(95);
    });
  });

  describe("sendEvent", () => {
    beforeEach(async () => {
      await sink.start("task");
      sendMessage.mockClear();
    });

    it("sends message events to the thread", async () => {
      await sink.sendEvent({ type: "message", content: "Hello" });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith("thread-1", "Hello");
    });

    it("skips events with no display content", async () => {
      await sink.sendEvent({ type: "start" });
      await sink.sendEvent({ type: "done", exitCode: 0 });

      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("sends tool events when showToolCalls is true", async () => {
      await sink.sendEvent({ type: "tool_use", toolName: "shell" });

      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it("skips tool events when showToolCalls is false", async () => {
      const noToolSink = new DiscordSink(
        sendMessage,
        createThread,
        "channel-1",
        { ...defaultConfig, showToolCalls: false },
      );
      await noToolSink.start("task");
      sendMessage.mockClear();

      await noToolSink.sendEvent({ type: "tool_use", toolName: "shell" });

      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("handles sendMessage errors gracefully", async () => {
      sendMessage.mockRejectedValueOnce(new Error("Discord error"));

      // Should not throw
      await sink.sendEvent({ type: "message", content: "Hello" });
    });
  });

  describe("finish", () => {
    beforeEach(async () => {
      await sink.start("task");
      sendMessage.mockClear();
    });

    it("sends summary to the main channel (not the thread)", async () => {
      const result: AcpxResult = {
        success: true,
        events: [{ type: "done", exitCode: 0 }],
        exitCode: 0,
      };

      await sink.finish(result);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      // Summary should go to main channel, not thread
      expect(sendMessage).toHaveBeenCalledWith(
        "channel-1",
        expect.stringContaining("Completed"),
      );
    });

    it("includes thread link in summary when thread was created", async () => {
      const result: AcpxResult = {
        success: true,
        events: [{ type: "done", exitCode: 0 }],
        exitCode: 0,
      };

      await sink.finish(result);

      expect(sendMessage).toHaveBeenCalledWith(
        "channel-1",
        expect.stringContaining("<#thread-1>"),
      );
    });

    it("sends failure summary for failed results", async () => {
      const result: AcpxResult = {
        success: false,
        error: "Process died",
        events: [{ type: "done", exitCode: 1 }],
        exitCode: 1,
      };

      await sink.finish(result);

      expect(sendMessage).toHaveBeenCalledWith(
        "channel-1",
        expect.stringContaining("Failed"),
      );
    });

    it("handles sendMessage errors gracefully", async () => {
      sendMessage.mockRejectedValueOnce(new Error("Discord error"));

      const result: AcpxResult = {
        success: true,
        events: [],
        exitCode: 0,
      };

      // Should not throw
      await sink.finish(result);
    });

    it("sends to original channel when no thread was created", async () => {
      const noThreadSink = new DiscordSink(
        sendMessage,
        createThread,
        "channel-1",
        { ...defaultConfig, useThread: false },
      );
      await noThreadSink.start("task");
      sendMessage.mockClear();

      const result: AcpxResult = {
        success: true,
        events: [{ type: "done", exitCode: 0 }],
        exitCode: 0,
      };

      await noThreadSink.finish(result);

      expect(sendMessage).toHaveBeenCalledWith(
        "channel-1",
        expect.stringContaining("Completed"),
      );
      // No thread link when thread wasn't created
      expect(sendMessage).toHaveBeenCalledWith(
        "channel-1",
        expect.not.stringContaining("<#"),
      );
    });
  });

  describe("finishInThread", () => {
    beforeEach(async () => {
      await sink.start("task");
      sendMessage.mockClear();
    });

    it("sends summary to the thread", async () => {
      const result: AcpxResult = {
        success: true,
        events: [{ type: "done", exitCode: 0 }],
        exitCode: 0,
      };

      await sink.finishInThread(result);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(
        "thread-1",
        expect.stringContaining("Completed"),
      );
    });

    it("is a no-op when no thread was created", async () => {
      const noThreadSink = new DiscordSink(
        sendMessage,
        createThread,
        "channel-1",
        { ...defaultConfig, useThread: false },
      );
      await noThreadSink.start("task");
      sendMessage.mockClear();

      const result: AcpxResult = {
        success: true,
        events: [{ type: "done", exitCode: 0 }],
        exitCode: 0,
      };

      await noThreadSink.finishInThread(result);

      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("getMainChannelId", () => {
    it("returns original channel id", () => {
      expect(sink.getMainChannelId()).toBe("channel-1");
    });

    it("returns original channel even after thread is created", async () => {
      await sink.start("task");
      expect(sink.getMainChannelId()).toBe("channel-1");
    });
  });

  describe("getThreadId", () => {
    it("returns undefined before start", () => {
      expect(sink.getThreadId()).toBeUndefined();
    });

    it("returns thread id after start", async () => {
      await sink.start("task");
      expect(sink.getThreadId()).toBe("thread-1");
    });
  });

  describe("getTargetChannelId", () => {
    it("returns original channel before start", () => {
      expect(sink.getTargetChannelId()).toBe("channel-1");
    });

    it("returns thread id after start with useThread", async () => {
      await sink.start("task");
      expect(sink.getTargetChannelId()).toBe("thread-1");
    });
  });
});
