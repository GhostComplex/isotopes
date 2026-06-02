import { describe, it, expect, vi } from "vitest";
import { runScheduledJob } from "./app.js";

function makeGateway(result?: { responseText?: string; errorMessage?: string | null }) {
  return {
    dispatchAndWait: vi.fn().mockResolvedValue({
      responseText: result?.responseText ?? "ok",
      errorMessage: result?.errorMessage ?? null,
    }),
  };
}

function makeDiscord(opts?: {
  history?: Array<{ messageId: string; sender: string; body: string; timestamp: number }>;
  fetchThrows?: Error;
  sendThrows?: Error;
}) {
  return {
    send: opts?.sendThrows ? vi.fn().mockRejectedValue(opts.sendThrows) : vi.fn().mockResolvedValue({ id: "out-1" }),
    fetchHistory: opts?.fetchThrows
      ? vi.fn().mockRejectedValue(opts.fetchThrows)
      : vi.fn().mockResolvedValue(opts?.history ?? []),
  };
}

describe("runScheduledJob", () => {
  it("no channel: dispatches the prompt as-is and posts nothing", async () => {
    const gateway = makeGateway({ responseText: "answer" });
    const discord = makeDiscord();

    const out = await runScheduledJob({
      source: "cron",
      agentId: "a",
      sessionKey: "k",
      prompt: "do the thing",
      gateway,
      discord,
    });

    expect(out).toEqual({ responseText: "answer", errorMessage: null });
    expect(gateway.dispatchAndWait).toHaveBeenCalledWith({
      agentId: "a",
      sessionKey: "k",
      content: "do the thing",
      source: "cron",
    });
    expect(discord.send).not.toHaveBeenCalled();
    expect(discord.fetchHistory).not.toHaveBeenCalled();
  });

  it("readLast > 0: prepends formatted history to the prompt", async () => {
    const gateway = makeGateway();
    const discord = makeDiscord({
      history: [
        { messageId: "m1", sender: "alice", body: "hello", timestamp: 100 },
        { messageId: "m2", sender: "bob", body: "world", timestamp: 200 },
      ],
    });

    await runScheduledJob({
      source: "cron",
      agentId: "a",
      sessionKey: "k",
      prompt: "summarize",
      channel: { accountId: "acct1", channelId: "ch1", readLast: 30 },
      gateway,
      discord,
    });

    expect(discord.fetchHistory).toHaveBeenCalledWith(
      { accountId: "acct1", channelId: "ch1" },
      { limit: 30 },
    );
    const sentPrompt = gateway.dispatchAndWait.mock.calls[0]![0].content;
    expect(sentPrompt).toContain("<channel_history>");
    expect(sentPrompt).toContain("hello");
    expect(sentPrompt).toContain("summarize");
    expect(sentPrompt.indexOf("<channel_history>")).toBeLessThan(sentPrompt.indexOf("summarize"));
  });

  it("readLast omitted: defaults to 25", async () => {
    const gateway = makeGateway();
    const discord = makeDiscord();
    await runScheduledJob({
      source: "cron",
      agentId: "a",
      sessionKey: "k",
      prompt: "p",
      channel: { accountId: "acct1", channelId: "ch1" },
      gateway,
      discord,
    });
    expect(discord.fetchHistory).toHaveBeenCalledWith(
      { accountId: "acct1", channelId: "ch1" },
      { limit: 25 },
    );
  });

  it("readLast = 0: explicitly skips fetchHistory", async () => {
    const gateway = makeGateway();
    const discord = makeDiscord();
    await runScheduledJob({
      source: "cron",
      agentId: "a",
      sessionKey: "k",
      prompt: "p",
      channel: { accountId: "acct1", channelId: "ch1", readLast: 0 },
      gateway,
      discord,
    });
    expect(discord.fetchHistory).not.toHaveBeenCalled();
  });

  it("read failure aborts before dispatch and propagates", async () => {
    const gateway = makeGateway();
    const discord = makeDiscord({ fetchThrows: new Error("read boom") });

    await expect(runScheduledJob({
      source: "cron",
      agentId: "a",
      sessionKey: "k",
      prompt: "p",
      channel: { accountId: "acct1", channelId: "ch1", readLast: 10 },
      gateway,
      discord,
    })).rejects.toThrow(/read boom/);

    expect(gateway.dispatchAndWait).not.toHaveBeenCalled();
    expect(discord.send).not.toHaveBeenCalled();
  });

  it("posts the response to the configured channel/thread", async () => {
    const gateway = makeGateway({ responseText: "agent says hi" });
    const discord = makeDiscord();
    await runScheduledJob({
      source: "cron",
      agentId: "a",
      sessionKey: "k",
      prompt: "p",
      channel: { accountId: "acct1", channelId: "ch1", threadId: "thr1" },
      gateway,
      discord,
    });
    expect(discord.send).toHaveBeenCalledWith(
      { accountId: "acct1", channelId: "ch1", threadId: "thr1" },
      "agent says hi",
    );
  });

  it("prefixes ⚠️ when the agent returned an errorMessage", async () => {
    const gateway = makeGateway({ responseText: "", errorMessage: "model timed out" });
    const discord = makeDiscord();
    await runScheduledJob({
      source: "cron",
      agentId: "a",
      sessionKey: "k",
      prompt: "p",
      channel: { accountId: "acct1", channelId: "ch1" },
      gateway,
      discord,
    });
    expect(discord.send).toHaveBeenCalledWith(
      { accountId: "acct1", channelId: "ch1" },
      "⚠️ model timed out",
    );
  });

  it("skips post when the response is empty and there is no error", async () => {
    const gateway = makeGateway({ responseText: "   " });
    const discord = makeDiscord();
    await runScheduledJob({
      source: "cron",
      agentId: "a",
      sessionKey: "k",
      prompt: "p",
      channel: { accountId: "acct1", channelId: "ch1" },
      gateway,
      discord,
    });
    expect(discord.send).not.toHaveBeenCalled();
  });

  it("send failure is swallowed (logged) — does not propagate", async () => {
    const gateway = makeGateway({ responseText: "hi" });
    const discord = makeDiscord({ sendThrows: new Error("post boom") });
    await expect(runScheduledJob({
      source: "cron",
      agentId: "a",
      sessionKey: "k",
      prompt: "p",
      channel: { accountId: "acct1", channelId: "ch1" },
      gateway,
      discord,
    })).resolves.toBeDefined();
    expect(discord.send).toHaveBeenCalledTimes(1);
  });

  it("readLast > 0 but Discord adapter missing → throws (mismatch)", async () => {
    const gateway = makeGateway();
    await expect(runScheduledJob({
      source: "heartbeat",
      agentId: "a",
      sessionKey: "k",
      prompt: "p",
      channel: { accountId: "acct1", channelId: "ch1", readLast: 5 },
      gateway,
      // discord omitted
    })).rejects.toThrow(/discord is not configured/i);
    expect(gateway.dispatchAndWait).not.toHaveBeenCalled();
  });
});
