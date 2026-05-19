// Tests for the Discord outbound streaming pipeline.
import { describe, it, expect, vi } from "vitest";
import type { Message as DiscordMessage, SendableChannels } from "discord.js";
import { SegmentedStreamBuffer, chunkDiscordMessage, createDiscordSubscriber } from "./outbound.js";
import type { SessionEvent } from "../../gateway/index.js";

describe("SegmentedStreamBuffer", () => {
  it("does not flush below maxBufferSize threshold", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new SegmentedStreamBuffer(onFlush, 50);
    await buf.append("Short text. With a boundary.");
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("flushes at sentence boundary once buffer >= threshold", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new SegmentedStreamBuffer(onFlush, 20);
    await buf.append("Hello world. This is more text without boundary");
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0]).toBe("Hello world. ");
    expect(buf.getBuffer()).toBe("This is more text without boundary");
  });

  it("flushRemaining drains the buffer", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new SegmentedStreamBuffer(onFlush, 1000);
    await buf.append("leftover");
    expect(onFlush).not.toHaveBeenCalled();
    await buf.flushRemaining();
    expect(onFlush).toHaveBeenCalledWith("leftover");
    expect(buf.getBuffer()).toBe("");
  });
});

describe("chunkDiscordMessage", () => {
  it("returns single chunk for short content", () => {
    expect(chunkDiscordMessage("hi")).toEqual(["hi"]);
  });

  it("splits content larger than max length", () => {
    const long = "x".repeat(2500);
    const chunks = chunkDiscordMessage(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    expect(chunks.join("")).toBe(long);
  });

  it("prefers newline break points", () => {
    const part = "a".repeat(1500) + "\n" + "b".repeat(1000);
    const chunks = chunkDiscordMessage(part);
    expect(chunks[0]).toBe("a".repeat(1500));
    expect(chunks[1]).toBe("b".repeat(1000));
  });
});

type SendMock = ReturnType<typeof vi.fn>;
type ReplyMock = ReturnType<typeof vi.fn>;

interface Mocks {
  channel: SendableChannels;
  triggerMessage: DiscordMessage;
  send: SendMock;
  reply: ReplyMock;
  sendTyping: ReturnType<typeof vi.fn>;
}

function makeMocks(triggerId = "trigger-123"): Mocks {
  const send: SendMock = vi.fn().mockResolvedValue({ id: "sent-1" });
  const reply: ReplyMock = vi.fn().mockResolvedValue({ id: "reply-1" });
  const sendTyping = vi.fn().mockResolvedValue(undefined);
  const channel = { send, sendTyping } as unknown as SendableChannels;
  const triggerMessage = { id: triggerId, reply } as unknown as DiscordMessage;
  return { channel, triggerMessage, send, reply, sendTyping };
}

const textDelta = (delta: string): SessionEvent => ({ type: "text_delta", delta });
const agentEnd = (): SessionEvent => ({ type: "agent_end", stopReason: "end" });

describe("createDiscordSubscriber", () => {
  it("plain text flushed on agent_end calls channel.send", async () => {
    const { channel, triggerMessage, send, reply } = makeMocks();
    const sub = createDiscordSubscriber({ channel, triggerMessageId: triggerMessage.id });
    sub.onEvent(textDelta("hello world"));
    sub.onEvent(agentEnd());
    await sub.done;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("hello world");
    expect(reply).not.toHaveBeenCalled();
  });

  it("[[reply_to_current]] routes to channel.send with reply ref to trigger", async () => {
    const { channel, triggerMessage, send } = makeMocks("trigger-123");
    const sub = createDiscordSubscriber({ channel, triggerMessageId: triggerMessage.id });
    sub.onEvent(textDelta("[[reply_to_current]]\nhi there"));
    sub.onEvent(agentEnd());
    await sub.done;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      content: "hi there",
      reply: { messageReference: "trigger-123", failIfNotExists: false },
    });
  });

  it("[[reply_to: <id>]] uses channel.send with reply messageReference", async () => {
    const { channel, triggerMessage, send } = makeMocks();
    const sub = createDiscordSubscriber({ channel, triggerMessageId: triggerMessage.id });
    sub.onEvent(textDelta("[[reply_to: 9876]]\nhi"));
    sub.onEvent(agentEnd());
    await sub.done;
    expect(send).toHaveBeenCalledWith({
      content: "hi",
      reply: { messageReference: "9876", failIfNotExists: false },
    });
  });

  it("chunks long messages over 2000 chars", async () => {
    const { channel, triggerMessage, send } = makeMocks();
    const sub = createDiscordSubscriber({ channel, triggerMessageId: triggerMessage.id });
    const huge = "x".repeat(2500);
    sub.onEvent(textDelta(huge));
    sub.onEvent(agentEnd());
    await sub.done;
    expect(send).toHaveBeenCalledTimes(2);
    const total = (send.mock.calls[0][0] as string) + (send.mock.calls[1][0] as string);
    expect(total).toBe(huge);
  });

  it("reply directive applies only to first chunk when chunked", async () => {
    const { channel, triggerMessage, send, reply } = makeMocks();
    const sub = createDiscordSubscriber({ channel, triggerMessageId: triggerMessage.id });
    sub.onEvent(textDelta("[[reply_to_current]]\n" + "x".repeat(2500)));
    sub.onEvent(agentEnd());
    await sub.done;
    expect(reply).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toMatchObject({ reply: { messageReference: "trigger-123" } });
    expect(typeof send.mock.calls[1][0]).toBe("string");
  });

  it("ignores zero-length deltas", async () => {
    const { channel, triggerMessage, send } = makeMocks();
    const sub = createDiscordSubscriber({ channel, triggerMessageId: triggerMessage.id });
    sub.onEvent(textDelta(""));
    sub.onEvent(agentEnd());
    await sub.done;
    expect(send).not.toHaveBeenCalled();
  });

  it("directive-only chunk produces no send", async () => {
    const { channel, triggerMessage, send, reply } = makeMocks();
    const sub = createDiscordSubscriber({ channel, triggerMessageId: triggerMessage.id });
    sub.onEvent(textDelta("[[reply_to_current]]\n"));
    sub.onEvent(agentEnd());
    await sub.done;
    expect(send).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("does not post tool status when showToolCalls is false (default)", async () => {
    const { channel, triggerMessage, send } = makeMocks();
    const sub = createDiscordSubscriber({ channel, triggerMessageId: triggerMessage.id });
    sub.onEvent({ type: "tool_call", toolCallId: "t1", toolName: "web_fetch", args: {} });
    sub.onEvent({ type: "tool_result", toolCallId: "t1", toolName: "web_fetch", result: null, isError: true });
    sub.onEvent(agentEnd());
    await sub.done;
    expect(send).not.toHaveBeenCalled();
  });

  it("posts a status line on tool_call when showToolCalls=true", async () => {
    const { channel, triggerMessage, send } = makeMocks();
    const sub = createDiscordSubscriber({ channel, triggerMessageId: triggerMessage.id, showToolCalls: true });
    sub.onEvent({ type: "tool_call", toolCallId: "t1", toolName: "web_fetch", args: {} });
    sub.onEvent(agentEnd());
    await sub.done;
    await Promise.resolve(); await Promise.resolve();
    expect(send).toHaveBeenCalledWith("🔧 web_fetch");
  });

  it("posts a failure line on tool_result error when showToolCalls=true", async () => {
    const { channel, triggerMessage, send } = makeMocks();
    const sub = createDiscordSubscriber({ channel, triggerMessageId: triggerMessage.id, showToolCalls: true });
    sub.onEvent({ type: "tool_result", toolCallId: "t1", toolName: "web_fetch", result: null, isError: true });
    sub.onEvent(agentEnd());
    await sub.done;
    await Promise.resolve(); await Promise.resolve();
    expect(send).toHaveBeenCalledWith("⚠️ web_fetch failed");
  });

  it("is silent on tool_result success when showToolCalls=true", async () => {
    const { channel, triggerMessage, send } = makeMocks();
    const sub = createDiscordSubscriber({ channel, triggerMessageId: triggerMessage.id, showToolCalls: true });
    sub.onEvent({ type: "tool_result", toolCallId: "t1", toolName: "web_fetch", result: "ok", isError: false });
    sub.onEvent(agentEnd());
    await sub.done;
    expect(send).not.toHaveBeenCalled();
  });

  it("typing indicator fires immediately and clears after agent_end", async () => {
    vi.useFakeTimers();
    try {
      const { channel, triggerMessage, sendTyping } = makeMocks();
      const sub = createDiscordSubscriber({ channel, triggerMessageId: triggerMessage.id });
      expect(sendTyping).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(7000);
      expect(sendTyping).toHaveBeenCalledTimes(2);
      sub.onEvent(agentEnd());
      // Allow the async agent_end handler to run flush + stopTyping.
      await vi.runAllTimersAsync();
      vi.advanceTimersByTime(20000);
      expect(sendTyping).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("NO_REPLY sentinel response is silently dropped (nothing sent)", async () => {
    const { channel, triggerMessage, send, reply } = makeMocks();
    const sub = createDiscordSubscriber({ channel, triggerMessageId: triggerMessage.id });
    sub.onEvent(textDelta("NO_REPLY"));
    sub.onEvent(agentEnd());
    await sub.done;
    expect(send).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("NO_REPLY with surrounding whitespace and reply directive still drops", async () => {
    const { channel, triggerMessage, send, reply } = makeMocks();
    const sub = createDiscordSubscriber({ channel, triggerMessageId: triggerMessage.id });
    sub.onEvent(textDelta("[[reply_to_current]]\n  NO_REPLY  "));
    sub.onEvent(agentEnd());
    await sub.done;
    expect(send).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });
});
