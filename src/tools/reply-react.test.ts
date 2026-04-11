// src/tools/reply-react.test.ts — Unit tests for message_reply and message_react tools

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMessageReplyTool,
  createMessageReactTool,
  createReplyReactTools,
  type ReplyReactToolContext,
} from "./reply-react.js";
import type { Transport } from "../core/types.js";

function createMockTransport(overrides: Partial<Transport> = {}): Transport {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue({ messageId: "reply-456" }),
    react: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("message_reply tool", () => {
  let ctx: ReplyReactToolContext;
  let transport: Transport;

  beforeEach(() => {
    transport = createMockTransport();
    ctx = { transport };
  });

  it("sends a reply and returns the reply message ID", async () => {
    const { handler } = createMessageReplyTool(ctx);
    const result = JSON.parse(await handler({ message_id: "msg-123", content: "Thanks!" }));
    expect(result.success).toBe(true);
    expect(result.reply_message_id).toBe("reply-456");
    expect(transport.reply).toHaveBeenCalledWith("msg-123", "Thanks!");
  });

  it("returns error for empty message_id", async () => {
    const { handler } = createMessageReplyTool(ctx);
    const result = JSON.parse(await handler({ message_id: "", content: "Hello" }));
    expect(result.error).toBe("message_id must not be empty");
  });

  it("returns error for empty content", async () => {
    const { handler } = createMessageReplyTool(ctx);
    const result = JSON.parse(await handler({ message_id: "msg-1", content: "" }));
    expect(result.error).toBe("content must not be empty");
  });

  it("returns error when transport does not support replies", async () => {
    const noReplyTransport = createMockTransport({ reply: undefined });
    const { handler } = createMessageReplyTool({ transport: noReplyTransport });
    const result = JSON.parse(await handler({ message_id: "msg-1", content: "hi" }));
    expect(result.error).toBe("Transport does not support replies");
  });

  it("returns transport error on failure", async () => {
    const failingTransport = createMockTransport({
      reply: vi.fn().mockRejectedValue(new Error("Message not found: msg-999")),
    });
    const { handler } = createMessageReplyTool({ transport: failingTransport });
    const result = JSON.parse(await handler({ message_id: "msg-999", content: "hi" }));
    expect(result.error).toBe("Message not found: msg-999");
  });
});

describe("message_react tool", () => {
  let ctx: ReplyReactToolContext;
  let transport: Transport;

  beforeEach(() => {
    transport = createMockTransport();
    ctx = { transport };
  });

  it("adds a reaction successfully", async () => {
    const { handler } = createMessageReactTool(ctx);
    const result = JSON.parse(await handler({ message_id: "msg-123", emoji: "👍" }));
    expect(result.success).toBe(true);
    expect(transport.react).toHaveBeenCalledWith("msg-123", "👍");
  });

  it("returns error for empty message_id", async () => {
    const { handler } = createMessageReactTool(ctx);
    const result = JSON.parse(await handler({ message_id: "", emoji: "👍" }));
    expect(result.error).toBe("message_id must not be empty");
  });

  it("returns error for empty emoji", async () => {
    const { handler } = createMessageReactTool(ctx);
    const result = JSON.parse(await handler({ message_id: "msg-1", emoji: "" }));
    expect(result.error).toBe("emoji must not be empty");
  });

  it("returns error when transport does not support reactions", async () => {
    const noReactTransport = createMockTransport({ react: undefined });
    const { handler } = createMessageReactTool({ transport: noReactTransport });
    const result = JSON.parse(await handler({ message_id: "msg-1", emoji: "👍" }));
    expect(result.error).toBe("Transport does not support reactions");
  });

  it("returns transport error on failure", async () => {
    const failingTransport = createMockTransport({
      react: vi.fn().mockRejectedValue(new Error("Unknown Emoji")),
    });
    const { handler } = createMessageReactTool({ transport: failingTransport });
    const result = JSON.parse(await handler({ message_id: "msg-1", emoji: "nope" }));
    expect(result.error).toBe("Unknown Emoji");
  });
});

describe("createReplyReactTools", () => {
  it("returns both tools", () => {
    const transport = createMockTransport();
    const tools = createReplyReactTools({ transport });
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.tool.name)).toEqual(["message_reply", "message_react"]);
  });
});
