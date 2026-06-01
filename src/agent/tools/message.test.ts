import { describe, it, expect, vi } from "vitest";
import { createMessageSendTool } from "./message.js";
import type { ChannelContext, ChannelActions } from "../../channels/types.js";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

function mockContext(actions?: ChannelActions): ChannelContext {
  return { getChannelActions: () => actions };
}

async function callTool(tool: AgentTool, args: unknown): Promise<unknown> {
  const result: AgentToolResult<unknown> = await tool.execute("test-call", args as never);
  const block = result.content.find((c) => c.type === "text") as { text: string } | undefined;
  return JSON.parse(block?.text ?? "{}");
}

describe("message_send tool", () => {
  it("sends a message and returns the message id", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ id: "msg-123" });
    const tool = createMessageSendTool(mockContext({ sendMessage }));
    const result = await callTool(tool, { channel_id: "ch-1", content: "hello" });
    expect(result).toEqual({ success: true, messageId: "msg-123" });
    expect(sendMessage).toHaveBeenCalledWith("ch-1", "hello");
  });

  it("rejects channels not in the allowlist", async () => {
    const sendMessage = vi.fn();
    const tool = createMessageSendTool(mockContext({ sendMessage }), ["ch-allowed"]);
    const result = await callTool(tool, { channel_id: "ch-other", content: "hello" });
    expect(result).toEqual({ error: "Channel ch-other is not in the allowed channels list" });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("allows channels in the allowlist", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ id: "msg-456" });
    const tool = createMessageSendTool(mockContext({ sendMessage }), ["ch-allowed"]);
    const result = await callTool(tool, { channel_id: "ch-allowed", content: "hi" });
    expect(result).toEqual({ success: true, messageId: "msg-456" });
  });

  it("returns error when channel actions are unavailable", async () => {
    const tool = createMessageSendTool(mockContext(undefined));
    const result = await callTool(tool, { channel_id: "ch-1", content: "hello" });
    expect(result).toEqual({ error: "Channel not available" });
  });

  it("returns error when sendMessage is not supported", async () => {
    const tool = createMessageSendTool(mockContext({}));
    const result = await callTool(tool, { channel_id: "ch-1", content: "hello" });
    expect(result).toEqual({ error: "Channel does not support sending messages" });
  });

  it("returns error for empty channel_id", async () => {
    const tool = createMessageSendTool(mockContext({ sendMessage: vi.fn() }));
    const result = await callTool(tool, { channel_id: "", content: "hello" });
    expect(result).toEqual({ error: "channel_id must not be empty" });
  });

  it("returns error for empty content", async () => {
    const tool = createMessageSendTool(mockContext({ sendMessage: vi.fn() }));
    const result = await callTool(tool, { channel_id: "ch-1", content: "" });
    expect(result).toEqual({ error: "content must not be empty" });
  });

  it("no allowlist means all channels are allowed", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ id: "msg-789" });
    const tool = createMessageSendTool(mockContext({ sendMessage }));
    const result = await callTool(tool, { channel_id: "any-channel", content: "hi" });
    expect(result).toEqual({ success: true, messageId: "msg-789" });
  });
});
