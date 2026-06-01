import { describe, expect, it, vi } from "vitest";
import { sendScheduledResult } from "./app.js";

describe("sendScheduledResult", () => {
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

  it("does nothing when there is no response text", async () => {
    const notify = vi.fn();

    await sendScheduledResult({ responseText: "", errorMessage: null }, undefined, { notify });

    expect(notify).not.toHaveBeenCalled();
  });
});
