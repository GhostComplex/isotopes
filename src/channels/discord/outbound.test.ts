// Tests for the Discord outbound streaming pipeline.
import { describe, it, expect, vi } from "vitest";
import type { Message as DiscordMessage, SendableChannels } from "discord.js";
import {
  SegmentedStreamBuffer,
  chunkDiscordMessage,
  createDiscordCallbacks,
} from "./outbound.js";

type SendMock = ReturnType<typeof vi.fn>;
type ReplyMock = ReturnType<typeof vi.fn>;

interface Mocks {
  channel: SendableChannels;
  triggerMessage: DiscordMessage;
  send: SendMock;
  reply: ReplyMock;
}

function makeMocks(triggerId = "trigger-123"): Mocks {
  const send: SendMock = vi.fn().mockResolvedValue({ id: "sent-1" });
  const reply: ReplyMock = vi.fn().mockResolvedValue({ id: "reply-1" });
  const channel = { send } as unknown as SendableChannels;
  const triggerMessage = { id: triggerId, reply } as unknown as DiscordMessage;
  return { channel, triggerMessage, send, reply };
}

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
    // Append until length >= 20, with a clean boundary.
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

  it("flushRemaining is a no-op when buffer is empty", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new SegmentedStreamBuffer(onFlush, 100);
    await buf.flushRemaining();
    expect(onFlush).not.toHaveBeenCalled();
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
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(2000);
    }
    expect(chunks.join("")).toBe(long);
  });

  it("prefers newline break points", () => {
    const part = "a".repeat(1500) + "\n" + "b".repeat(1000);
    const chunks = chunkDiscordMessage(part);
    expect(chunks[0]).toBe("a".repeat(1500));
    expect(chunks[1]).toBe("b".repeat(1000));
  });
});

describe("createDiscordCallbacks", () => {
  it("plain text flushed via flushRemaining calls channel.send", async () => {
    const { channel, triggerMessage, send, reply } = makeMocks();
    const cb = createDiscordCallbacks({ channel, triggerMessage });
    cb.onTextDelta!("hello world");
    await cb.flushRemaining();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("hello world");
    expect(reply).not.toHaveBeenCalled();
  });

  it("[[reply_to_current]] routes to triggerMessage.reply", async () => {
    const { channel, triggerMessage, send, reply } = makeMocks();
    const cb = createDiscordCallbacks({ channel, triggerMessage });
    cb.onTextDelta!("[[reply_to_current]]\nhi there");
    await cb.flushRemaining();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({ content: "hi there" });
    expect(send).not.toHaveBeenCalled();
  });

  it("[[reply_to: <id>]] uses channel.send with reply messageReference", async () => {
    const { channel, triggerMessage, send, reply } = makeMocks();
    const cb = createDiscordCallbacks({ channel, triggerMessage });
    cb.onTextDelta!("[[reply_to: 9876]]\nhi");
    await cb.flushRemaining();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      content: "hi",
      reply: { messageReference: "9876", failIfNotExists: false },
    });
    expect(reply).not.toHaveBeenCalled();
  });

  it("chunks long messages over 2000 chars", async () => {
    const { channel, triggerMessage, send } = makeMocks();
    const cb = createDiscordCallbacks({ channel, triggerMessage });
    const huge = "x".repeat(2500);
    cb.onTextDelta!(huge);
    await cb.flushRemaining();
    expect(send).toHaveBeenCalledTimes(2);
    const total = (send.mock.calls[0][0] as string) + (send.mock.calls[1][0] as string);
    expect(total).toBe(huge);
  });

  it("reply directive applies only to first chunk when chunked", async () => {
    const { channel, triggerMessage, send, reply } = makeMocks();
    const cb = createDiscordCallbacks({ channel, triggerMessage });
    cb.onTextDelta!("[[reply_to_current]]\n" + "x".repeat(2500));
    await cb.flushRemaining();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1); // remaining chunk goes via channel.send
  });

  it("ignores zero-length deltas", async () => {
    const { channel, triggerMessage, send } = makeMocks();
    const cb = createDiscordCallbacks({ channel, triggerMessage });
    cb.onTextDelta!("");
    await cb.flushRemaining();
    expect(send).not.toHaveBeenCalled();
  });

  it("directive-only chunk produces no send", async () => {
    const { channel, triggerMessage, send, reply } = makeMocks();
    const cb = createDiscordCallbacks({ channel, triggerMessage });
    cb.onTextDelta!("[[reply_to_current]]\n");
    await cb.flushRemaining();
    expect(send).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("does not register tool callbacks when showToolCalls is false (default)", () => {
    const { channel, triggerMessage } = makeMocks();
    const cb = createDiscordCallbacks({ channel, triggerMessage });
    expect(cb.onToolStart).toBeUndefined();
    expect(cb.onToolEnd).toBeUndefined();
  });

  it("onToolStart posts a status line when showToolCalls=true", async () => {
    const { channel, triggerMessage, send } = makeMocks();
    const cb = createDiscordCallbacks({ channel, triggerMessage, showToolCalls: true });
    expect(cb.onToolStart).toBeDefined();
    cb.onToolStart!({ id: "t1", name: "web_fetch", args: {} });
    // Allow microtasks queued by `void channel.send(...)` to settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith("🔧 web_fetch");
  });

  it("onToolEnd posts a failure line on error when showToolCalls=true", async () => {
    const { channel, triggerMessage, send } = makeMocks();
    const cb = createDiscordCallbacks({ channel, triggerMessage, showToolCalls: true });
    expect(cb.onToolEnd).toBeDefined();
    cb.onToolEnd!({ id: "t1", name: "web_fetch", result: null, isError: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith("⚠️ web_fetch failed");
  });

  it("onToolEnd is silent on success", async () => {
    const { channel, triggerMessage, send } = makeMocks();
    const cb = createDiscordCallbacks({ channel, triggerMessage, showToolCalls: true });
    cb.onToolEnd!({ id: "t1", name: "web_fetch", result: "ok", isError: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
  });
});
