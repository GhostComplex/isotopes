// src/tools/reply-react.test.ts — Unit tests for message_react tool

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMessageReactTool,
  createReplyReactTools,
  LazyTransportContext,
  type ReplyReactToolContext,
} from "./reply-react.js";
import type { Transport } from "../core/types.js";

function createMockTransport(overrides: Partial<Transport> = {}): Transport {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    react: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function wrapTransport(transport: Transport): ReplyReactToolContext {
  return { getTransport: () => transport };
}

describe("message_react tool", () => {
  let ctx: ReplyReactToolContext;
  let transport: Transport;

  beforeEach(() => {
    transport = createMockTransport();
    ctx = wrapTransport(transport);
  });

  it("adds a reaction successfully", async () => {
    const { handler } = createMessageReactTool(ctx);
    const result = JSON.parse(await handler({ message_id: "msg-123", emoji: "\u{1F44D}" }));
    expect(result.success).toBe(true);
    expect(transport.react).toHaveBeenCalledWith("msg-123", "\u{1F44D}", undefined);
  });

  it("passes channel_id to transport when provided", async () => {
    const { handler } = createMessageReactTool(ctx);
    const result = JSON.parse(
      await handler({ message_id: "msg-123", channel_id: "ch-2", emoji: "\u{1F44D}" }),
    );
    expect(result.success).toBe(true);
    expect(transport.react).toHaveBeenCalledWith("msg-123", "\u{1F44D}", "ch-2");
  });

  it("returns error for empty message_id", async () => {
    const { handler } = createMessageReactTool(ctx);
    const result = JSON.parse(await handler({ message_id: "", emoji: "\u{1F44D}" }));
    expect(result.error).toBe("message_id must not be empty");
  });

  it("returns error for empty emoji", async () => {
    const { handler } = createMessageReactTool(ctx);
    const result = JSON.parse(await handler({ message_id: "msg-1", emoji: "" }));
    expect(result.error).toBe("emoji must not be empty");
  });

  it("returns error when transport is not available", async () => {
    const { handler } = createMessageReactTool({ getTransport: () => undefined });
    const result = JSON.parse(await handler({ message_id: "msg-1", emoji: "\u{1F44D}" }));
    expect(result.error).toBe("Transport not available");
  });

  it("returns error when transport does not support reactions", async () => {
    const noReactTransport = createMockTransport({ react: undefined });
    const { handler } = createMessageReactTool(wrapTransport(noReactTransport));
    const result = JSON.parse(await handler({ message_id: "msg-1", emoji: "\u{1F44D}" }));
    expect(result.error).toBe("Transport does not support reactions");
  });

  it("returns transport error on failure", async () => {
    const failingTransport = createMockTransport({
      react: vi.fn().mockRejectedValue(new Error("Unknown Emoji")),
    });
    const { handler } = createMessageReactTool(wrapTransport(failingTransport));
    const result = JSON.parse(await handler({ message_id: "msg-1", emoji: "nope" }));
    expect(result.error).toBe("Unknown Emoji");
  });
});

describe("LazyTransportContext", () => {
  it("returns undefined before transport is set", () => {
    const ctx = new LazyTransportContext();
    expect(ctx.getTransport()).toBeUndefined();
  });

  it("returns transport after setTransport is called", () => {
    const ctx = new LazyTransportContext();
    const transport = createMockTransport();
    ctx.setTransport(transport);
    expect(ctx.getTransport()).toBe(transport);
  });

  it("works end-to-end with tool handlers", async () => {
    const ctx = new LazyTransportContext();
    const { handler: reactHandler } = createMessageReactTool(ctx);

    // Before transport is set → error
    const before = JSON.parse(await reactHandler({ message_id: "m1", emoji: "\u{1F44D}" }));
    expect(before.error).toBe("Transport not available");

    // After transport is set → success
    const transport = createMockTransport();
    ctx.setTransport(transport);
    const after = JSON.parse(await reactHandler({ message_id: "m1", emoji: "\u{1F44D}" }));
    expect(after.success).toBe(true);
  });
});

describe("createReplyReactTools", () => {
  it("returns the react tool only (message_reply removed)", () => {
    const transport = createMockTransport();
    const tools = createReplyReactTools(wrapTransport(transport));
    expect(tools.map((t) => t.tool.name)).toEqual(["message_react"]);
  });
});
