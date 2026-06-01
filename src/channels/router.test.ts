import { describe, it, expect } from "vitest";
import { ChannelRouter } from "./router.js";
import type { MessagingChannel } from "./types.js";

function makeChannel(kind: string): MessagingChannel {
  return {
    kind,
    start: async () => {},
    stop: async () => {},
    send: async (target, content) => ({ id: `${kind}:${target.channelId}:${content}` }),
    fetchHistory: async (target, { limit }) => [
      { messageId: "m1", sender: "alice", body: `${kind}:${target.channelId}:${limit}`, timestamp: 1 },
    ],
  };
}

describe("ChannelRouter", () => {
  it("dispatches send to the channel matching target.type", async () => {
    const r = new ChannelRouter();
    r.register([makeChannel("discord"), makeChannel("telegram")]);
    const out = await r.send({ type: "telegram", channelId: "c1" }, "hi");
    expect(out).toEqual({ id: "telegram:c1:hi" });
  });

  it("fetches history via the matching channel", async () => {
    const r = new ChannelRouter();
    r.register([makeChannel("discord")]);
    const history = await r.fetchHistory({ type: "discord", channelId: "c1" }, { limit: 5 });
    expect(history[0]?.body).toBe("discord:c1:5");
  });

  it("throws when no channel matches the target type", async () => {
    const r = new ChannelRouter();
    r.register([makeChannel("discord")]);
    await expect(r.send({ type: "feishu", channelId: "c1" }, "hi")).rejects.toThrow(/no channel registered/i);
  });

  it("skips non-messaging channels and rejects duplicate kinds", () => {
    const r = new ChannelRouter();
    r.register([{ kind: "noop", start: async () => {}, stop: async () => {} }]);
    expect(r.has("noop")).toBe(false);

    expect(() => r.register([makeChannel("discord"), makeChannel("discord")])).toThrow(/duplicate/i);
  });
});
