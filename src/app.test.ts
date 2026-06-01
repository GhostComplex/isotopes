import { describe, expect, it, vi } from "vitest";
import { sendScheduledResult } from "./app.js";

describe("sendScheduledResult", () => {
  it("prefers the error message over the normal response text", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);

    await sendScheduledResult(
      { responseText: "body", errorMessage: "boom" },
      { type: "discord", channelId: "chan-1" },
      { notify },
    );

    expect(notify).toHaveBeenCalledWith({ type: "discord", channelId: "chan-1" }, "⚠️ boom");
  });

  it("sends the agent response to the configured Discord target", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);

    await sendScheduledResult(
      {
        responseText: "hello from cron",
        errorMessage: null,
      },
      {
        type: "discord",
        channelId: "chan-1",
        threadId: "thr-1",
      },
      { notify },
    );

    expect(notify).toHaveBeenCalledWith(
      {
        type: "discord",
        channelId: "chan-1",
        threadId: "thr-1",
      },
      "hello from cron",
    );
  });

  it("does nothing when there is no target", async () => {
    const notify = vi.fn();

    await sendScheduledResult(
      { responseText: "hello", errorMessage: null },
      undefined,
      { notify },
    );

    expect(notify).not.toHaveBeenCalled();
  });

  it("does nothing when there is no response text", async () => {
    const notify = vi.fn();

    await sendScheduledResult({ responseText: "", errorMessage: null }, { type: "discord", channelId: "chan-1" }, { notify });

    expect(notify).not.toHaveBeenCalled();
  });

  it("logs and swallows notify failures", async () => {
    const notify = vi.fn().mockRejectedValue(new Error("bad channel"));

    await expect(sendScheduledResult(
      { responseText: "hello", errorMessage: null },
      { type: "discord", channelId: "chan-1" },
      { notify },
    )).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledTimes(1);
  });
});
