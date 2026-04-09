// src/subagent/discord-sink.test.ts — Unit tests for DiscordSink
// Uses a mock Discord channel to verify message formatting and threading.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiscordSink, type DiscordChannel } from "./discord-sink.js";
import type { ClaudeEvent, ClaudeResult } from "./claude-runner.js";

// Suppress log output in tests
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

// ---------------------------------------------------------------------------
// Mock Discord channel
// ---------------------------------------------------------------------------

function createMockChannel(opts: { supportsThreads?: boolean } = {}): DiscordChannel & {
  sentMessages: string[];
  mockThread: DiscordChannel & { sentMessages: string[] };
} {
  const threadMessages: string[] = [];
  const mockThread: DiscordChannel & { sentMessages: string[] } = {
    id: "thread-123",
    sentMessages: threadMessages,
    send: vi.fn(async (options: { content: string }) => {
      threadMessages.push(options.content);
      return { id: "msg-t-" + threadMessages.length };
    }),
  };

  const channelMessages: string[] = [];
  const channel: DiscordChannel & {
    sentMessages: string[];
    mockThread: typeof mockThread;
  } = {
    id: "channel-456",
    sentMessages: channelMessages,
    mockThread,
    send: vi.fn(async (options: { content: string }) => {
      channelMessages.push(options.content);
      return { id: "msg-c-" + channelMessages.length };
    }),
    ...(opts.supportsThreads !== false
      ? {
          threads: {
            create: vi.fn(async () => mockThread),
          },
        }
      : {}),
  };

  return channel;
}

describe("DiscordSink", () => {
  let channel: ReturnType<typeof createMockChannel>;

  beforeEach(() => {
    channel = createMockChannel();
  });

  // -------------------------------------------------------------------------
  // start()
  // -------------------------------------------------------------------------

  describe("start()", () => {
    it("creates a thread when useThread=true and threads available", async () => {
      const sink = new DiscordSink(channel, { useThread: true });
      const id = await sink.start("Test Task");

      expect(id).toBe("thread-123");
      expect(channel.threads!.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Test Task" }),
      );
      // "Task started" message should go to the thread
      expect(channel.mockThread.sentMessages).toHaveLength(1);
      expect(channel.mockThread.sentMessages[0]).toContain("Task started");
    });

    it("falls back to channel when useThread=false", async () => {
      const sink = new DiscordSink(channel, { useThread: false });
      const id = await sink.start("Test Task");

      expect(id).toBe("channel-456");
      expect(channel.sentMessages).toHaveLength(1);
      expect(channel.sentMessages[0]).toContain("Task started");
    });

    it("falls back to channel when threads not supported", async () => {
      const noThreadChannel = createMockChannel({ supportsThreads: false });
      const sink = new DiscordSink(noThreadChannel, { useThread: true });
      const id = await sink.start("Test Task");

      expect(id).toBe("channel-456");
      expect(noThreadChannel.sentMessages[0]).toContain("Task started");
    });

    it("truncates long task names", async () => {
      const sink = new DiscordSink(channel, { useThread: true });
      const longName = "A".repeat(200);
      await sink.start(longName);

      expect(channel.threads!.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: expect.stringMatching(/^A+/),
        }),
      );
      const callArgs = (channel.threads!.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.name.length).toBeLessThanOrEqual(100);
    });
  });

  // -------------------------------------------------------------------------
  // sendEvent()
  // -------------------------------------------------------------------------

  describe("sendEvent()", () => {
    it("sends assistant_message content", async () => {
      const sink = new DiscordSink(channel, { useThread: false });
      await sink.start("task");

      await sink.sendEvent({ type: "assistant_message", content: "Hello!" });

      expect(channel.sentMessages).toContain("Hello!");
    });

    it("sends tool_use when showToolCalls=true", async () => {
      const sink = new DiscordSink(channel, {
        useThread: false,
        showToolCalls: true,
      });
      await sink.start("task");

      const event: ClaudeEvent = {
        type: "tool_use",
        toolName: "shell",
        toolInput: { command: "ls -la" },
      };
      await sink.sendEvent(event);

      const lastMsg = channel.sentMessages[channel.sentMessages.length - 1];
      expect(lastMsg).toContain("**Tool:** `shell`");
      expect(lastMsg).toContain("ls -la");
    });

    it("skips tool_use when showToolCalls=false", async () => {
      const sink = new DiscordSink(channel, {
        useThread: false,
        showToolCalls: false,
      });
      await sink.start("task");

      await sink.sendEvent({ type: "tool_use", toolName: "shell" });

      // Only the "Task started" message should be present
      expect(channel.sentMessages).toHaveLength(1);
    });

    it("sends tool_result when showToolCalls=true", async () => {
      const sink = new DiscordSink(channel, {
        useThread: false,
        showToolCalls: true,
      });
      await sink.start("task");

      await sink.sendEvent({
        type: "tool_result",
        toolResult: "file1.txt\nfile2.txt",
      });

      const lastMsg = channel.sentMessages[channel.sentMessages.length - 1];
      expect(lastMsg).toContain("Tool result");
      expect(lastMsg).toContain("file1.txt");
    });

    it("sends thinking when showThinking=true", async () => {
      const sink = new DiscordSink(channel, {
        useThread: false,
        showThinking: true,
      });
      await sink.start("task");

      await sink.sendEvent({
        type: "thinking",
        content: "Let me think about this...",
      });

      const lastMsg = channel.sentMessages[channel.sentMessages.length - 1];
      expect(lastMsg).toContain("Thinking");
      expect(lastMsg).toContain("Let me think about this...");
    });

    it("skips thinking when showThinking=false", async () => {
      const sink = new DiscordSink(channel, {
        useThread: false,
        showThinking: false,
      });
      await sink.start("task");

      await sink.sendEvent({
        type: "thinking",
        content: "secret thoughts",
      });

      // Only "Task started"
      expect(channel.sentMessages).toHaveLength(1);
    });

    it("sends error events", async () => {
      const sink = new DiscordSink(channel, { useThread: false });
      await sink.start("task");

      await sink.sendEvent({ type: "error", error: "Rate limit hit" });

      const lastMsg = channel.sentMessages[channel.sentMessages.length - 1];
      expect(lastMsg).toContain("**Error:**");
      expect(lastMsg).toContain("Rate limit hit");
    });

    it("skips done events (handled by finish)", async () => {
      const sink = new DiscordSink(channel, { useThread: false });
      await sink.start("task");

      await sink.sendEvent({ type: "done" });

      // Only "Task started"
      expect(channel.sentMessages).toHaveLength(1);
    });

    it("skips assistant_message with no content", async () => {
      const sink = new DiscordSink(channel, { useThread: false });
      await sink.start("task");

      await sink.sendEvent({ type: "assistant_message" });

      expect(channel.sentMessages).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // finish()
  // -------------------------------------------------------------------------

  describe("finish()", () => {
    it("posts success summary with output", async () => {
      const sink = new DiscordSink(channel, { useThread: false });
      await sink.start("task");

      const result: ClaudeResult = {
        success: true,
        output: "All tests passed!",
        events: [],
      };
      await sink.finish(result);

      const lastMsg = channel.sentMessages[channel.sentMessages.length - 1];
      expect(lastMsg).toContain("**Task completed**");
      expect(lastMsg).toContain("All tests passed!");
    });

    it("posts success summary without output", async () => {
      const sink = new DiscordSink(channel, { useThread: false });
      await sink.start("task");

      const result: ClaudeResult = {
        success: true,
        events: [],
      };
      await sink.finish(result);

      const lastMsg = channel.sentMessages[channel.sentMessages.length - 1];
      expect(lastMsg).toContain("Task completed");
      expect(lastMsg).toContain("no output");
    });

    it("posts failure summary", async () => {
      const sink = new DiscordSink(channel, { useThread: false });
      await sink.start("task");

      const result: ClaudeResult = {
        success: false,
        error: "Process exited with code 1",
        events: [],
      };
      await sink.finish(result);

      const lastMsg = channel.sentMessages[channel.sentMessages.length - 1];
      expect(lastMsg).toContain("**Task failed:**");
      expect(lastMsg).toContain("Process exited with code 1");
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles send failure gracefully", async () => {
      const failChannel = createMockChannel({ supportsThreads: false });
      failChannel.send = vi.fn().mockRejectedValue(new Error("Network error"));

      const sink = new DiscordSink(failChannel, { useThread: false });

      // Should not throw
      await sink.start("task");
      await sink.sendEvent({ type: "assistant_message", content: "test" });
    });

    it("handles thread creation failure gracefully", async () => {
      const failChannel = createMockChannel();
      failChannel.threads!.create = vi.fn().mockRejectedValue(new Error("Missing permissions"));

      const sink = new DiscordSink(failChannel, { useThread: true });
      const id = await sink.start("task");

      // Should fall back to channel
      expect(id).toBe("channel-456");
    });
  });
});
