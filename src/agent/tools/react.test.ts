import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMessageReactTool,
  createReactTools,
} from "./react.js";
import { LazyChannelContext, type ChannelContext } from "../../channels/channel-context.js";
import type { Channel } from "../../channels/types.js";

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

async function callTool(tool: AgentTool, args: unknown): Promise<string> {
  const result: AgentToolResult<unknown> = await tool.execute("test-call", args as never);
  const block = result.content.find((c) => c.type === "text") as { text: string } | undefined;
  return block?.text ?? "";
}


function createMockChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    react: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function wrapChannel(channel: Channel): ChannelContext {
  return { getChannel: () => channel };
}

describe("message_react tool", () => {
  let ctx: ChannelContext;
  let channel: Channel;

  beforeEach(() => {
    channel = createMockChannel();
    ctx = wrapChannel(channel);
  });

  it("adds a reaction successfully", async () => {
    const tool = createMessageReactTool(ctx);
    const result = JSON.parse(await callTool(tool, { message_id: "msg-123", emoji: "\u{1F44D}" }));
    expect(result.success).toBe(true);
    expect(channel.react).toHaveBeenCalledWith("msg-123", "\u{1F44D}", undefined);
  });

  it("passes channel_id to channel when provided", async () => {
    const tool = createMessageReactTool(ctx);
    const result = JSON.parse(
      await callTool(tool, { message_id: "msg-123", channel_id: "ch-2", emoji: "\u{1F44D}" }),
    );
    expect(result.success).toBe(true);
    expect(channel.react).toHaveBeenCalledWith("msg-123", "\u{1F44D}", "ch-2");
  });

  it("returns error for empty message_id", async () => {
    const tool = createMessageReactTool(ctx);
    const result = JSON.parse(await callTool(tool, { message_id: "", emoji: "\u{1F44D}" }));
    expect(result.error).toBe("message_id must not be empty");
  });

  it("returns error for empty emoji", async () => {
    const tool = createMessageReactTool(ctx);
    const result = JSON.parse(await callTool(tool, { message_id: "msg-1", emoji: "" }));
    expect(result.error).toBe("emoji must not be empty");
  });

  it("returns error when channel is not available", async () => {
    const tool = createMessageReactTool({ getChannel: () => undefined });
    const result = JSON.parse(await callTool(tool, { message_id: "msg-1", emoji: "\u{1F44D}" }));
    expect(result.error).toBe("Channel not available");
  });

  it("returns error when channel does not support reactions", async () => {
    const noReactChannel = createMockChannel({ react: undefined });
    const tool = createMessageReactTool(wrapChannel(noReactChannel));
    const result = JSON.parse(await callTool(tool, { message_id: "msg-1", emoji: "\u{1F44D}" }));
    expect(result.error).toBe("Channel does not support reactions");
  });

  it("returns channel error on failure", async () => {
    const failingChannel = createMockChannel({
      react: vi.fn().mockRejectedValue(new Error("Unknown Emoji")),
    });
    const tool = createMessageReactTool(wrapChannel(failingChannel));
    const result = JSON.parse(await callTool(tool, { message_id: "msg-1", emoji: "nope" }));
    expect(result.error).toBe("Unknown Emoji");
  });
});

describe("LazyChannelContext", () => {
  it("returns undefined before channel is set", () => {
    const ctx = new LazyChannelContext();
    expect(ctx.getChannel()).toBeUndefined();
  });

  it("returns channel after setChannel is called", () => {
    const ctx = new LazyChannelContext();
    const channel = createMockChannel();
    ctx.setChannel(channel);
    expect(ctx.getChannel()).toBe(channel);
  });

  it("works end-to-end with tool handlers", async () => {
    const ctx = new LazyChannelContext();
    const tool = createMessageReactTool(ctx);

    // Before channel is set → error
    const before = JSON.parse(await callTool(tool, { message_id: "m1", emoji: "\u{1F44D}" }));
    expect(before.error).toBe("Channel not available");

    // After channel is set → success
    const channel = createMockChannel();
    ctx.setChannel(channel);
    const after = JSON.parse(await callTool(tool, { message_id: "m1", emoji: "\u{1F44D}" }));
    expect(after.success).toBe(true);
  });
});

describe("createReactTools", () => {
  it("returns the react tool", () => {
    const channel = createMockChannel();
    const tools = createReactTools(wrapChannel(channel));
    expect(tools.map((t) => t.name)).toEqual(["message_react"]);
  });
});
