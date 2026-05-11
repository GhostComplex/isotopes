import { describe, it, expect } from "vitest";
import type { Message as DiscordMessage } from "discord.js";
import { resolveAgentId } from "./routing.js";
import type { DiscordAccountConfig } from "./types.js";

interface FakeMsgOpts {
  channelId?: string;
  threadId?: string | null;
  parentChannelId?: string;
}

function fakeMsg(opts: FakeMsgOpts = {}): DiscordMessage {
  const isThread = Boolean(opts.threadId);
  const channelId = isThread ? opts.threadId! : opts.channelId ?? "channel-1";
  const channel = isThread
    ? { isThread: () => true, parentId: opts.parentChannelId ?? "channel-parent-1" }
    : { isThread: () => false };
  return { channelId, channel } as unknown as DiscordMessage;
}

describe("resolveAgentId", () => {
  it("falls back to the bot's default agentId when no override applies", () => {
    const account: DiscordAccountConfig = { defaultAgentId: "main" };
    expect(resolveAgentId(fakeMsg({ channelId: "ch-1" }), account)).toBe("main");
  });

  it("honors perChannelAgent override for matching channel", () => {
    const account: DiscordAccountConfig = {
      defaultAgentId: "main",
      perChannelAgent: { "ch-special": "specialist" },
    };
    expect(resolveAgentId(fakeMsg({ channelId: "ch-special" }), account)).toBe("specialist");
    expect(resolveAgentId(fakeMsg({ channelId: "ch-other" }), account)).toBe("main");
  });

  it("thread inherits parent channel's perChannelAgent mapping", () => {
    const account: DiscordAccountConfig = {
      defaultAgentId: "main",
      perChannelAgent: { "ch-parent": "specialist" },
    };
    const msg = fakeMsg({ threadId: "thr-1", parentChannelId: "ch-parent" });
    expect(resolveAgentId(msg, account)).toBe("specialist");
  });

  it("thread without matching parent override falls back to default agentId", () => {
    const account: DiscordAccountConfig = {
      defaultAgentId: "main",
      perChannelAgent: { "ch-other": "specialist" },
    };
    const msg = fakeMsg({ threadId: "thr-1", parentChannelId: "ch-parent" });
    expect(resolveAgentId(msg, account)).toBe("main");
  });
});
