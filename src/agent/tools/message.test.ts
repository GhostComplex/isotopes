import { describe, it, expect, vi } from "vitest";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { createMessageTool } from "./message.js";
import type { ChannelActions, ChannelContext } from "../../channels/types.js";

function mockCtx(actions?: ChannelActions): ChannelContext {
  return { getChannelActions: () => actions };
}

async function callTool(tool: AgentTool, args: unknown): Promise<Record<string, unknown>> {
  const result: AgentToolResult<unknown> = await tool.execute("call", args as never);
  const block = result.content.find((c) => c.type === "text") as { text: string } | undefined;
  return JSON.parse(block?.text ?? "{}");
}

describe("message tool", () => {
  it("send: forwards to actions.send and returns messageId", async () => {
    const send = vi.fn().mockResolvedValue({ id: "m-1" });
    const tool = createMessageTool(mockCtx({ send }));
    const out = await callTool(tool, {
      action: "send",
      target: { type: "discord", channelId: "c1" },
      content: "hello",
    });
    expect(out).toEqual({ ok: true, messageId: "m-1" });
    expect(send).toHaveBeenCalledWith({ type: "discord", channelId: "c1" }, "hello");
  });

  it("send: defaults target.type to discord when omitted", async () => {
    const send = vi.fn().mockResolvedValue({ id: "m-1" });
    const tool = createMessageTool(mockCtx({ send }));
    await callTool(tool, {
      action: "send",
      target: { channelId: "c1" },
      content: "hi",
    });
    expect(send.mock.calls[0]?.[0]).toEqual({ type: "discord", channelId: "c1" });
  });

  it("read: returns messages from fetchHistory clamped to [1, 100]", async () => {
    const fetchHistory = vi.fn().mockResolvedValue([
      { messageId: "m1", sender: "a", body: "hi", timestamp: 1 },
    ]);
    const tool = createMessageTool(mockCtx({ fetchHistory }));
    const out = await callTool(tool, {
      action: "read",
      target: { type: "discord", channelId: "c1" },
      limit: 999,
    });
    expect(out).toMatchObject({ ok: true, messages: [{ messageId: "m1" }] });
    expect(fetchHistory).toHaveBeenCalledWith({ type: "discord", channelId: "c1" }, { limit: 100 });
  });

  it("read: defaults limit to 30 when omitted", async () => {
    const fetchHistory = vi.fn().mockResolvedValue([]);
    const tool = createMessageTool(mockCtx({ fetchHistory }));
    await callTool(tool, {
      action: "read",
      target: { type: "discord", channelId: "c1" },
    });
    expect(fetchHistory.mock.calls[0]?.[1]).toEqual({ limit: 30 });
  });

  it("rejects channel not in allowlist (type:channelId form)", async () => {
    const send = vi.fn();
    const tool = createMessageTool(mockCtx({ send }), ["discord:allowed"]);
    const out = await callTool(tool, {
      action: "send",
      target: { type: "discord", channelId: "other" },
      content: "hi",
    });
    expect(out).toEqual({ error: "Channel discord:other is not in the allowed channels list" });
    expect(send).not.toHaveBeenCalled();
  });

  it("accepts bare channelId allowlist entry across types", async () => {
    const send = vi.fn().mockResolvedValue({ id: "m-1" });
    const tool = createMessageTool(mockCtx({ send }), ["123"]);
    const out = await callTool(tool, {
      action: "send",
      target: { type: "discord", channelId: "123" },
      content: "hi",
    });
    expect(out).toEqual({ ok: true, messageId: "m-1" });
  });

  it("send: errors on empty content", async () => {
    const tool = createMessageTool(mockCtx({ send: vi.fn() }));
    const out = await callTool(tool, {
      action: "send",
      target: { type: "discord", channelId: "c1" },
      content: "  ",
    });
    expect(out).toEqual({ error: "content must not be empty for action=send" });
  });

  it("errors when channel runtime is unavailable", async () => {
    const tool = createMessageTool(mockCtx(undefined));
    const out = await callTool(tool, {
      action: "send",
      target: { type: "discord", channelId: "c1" },
      content: "hi",
    });
    expect(out).toEqual({ error: "Channel runtime not available" });
  });

  it("read: errors when the channel does not support history", async () => {
    const tool = createMessageTool(mockCtx({ send: vi.fn() })); // no fetchHistory
    const out = await callTool(tool, {
      action: "read",
      target: { type: "discord", channelId: "c1" },
    });
    expect(out).toEqual({ error: "Channel does not support reading history" });
  });
});
