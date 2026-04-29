// src/transport/context.test.ts

import { describe, it, expect } from "vitest";
import { runWithMessageContext, getMessageContext } from "./context.js";

describe("MessageContext AsyncLocalStorage", () => {
  it("returns undefined when not set", () => {
    expect(getMessageContext()).toBeUndefined();
  });

  it("propagates context inside the callback", () => {
    const ctx = { transport: "discord", channelKey: "1", agentId: "main" } as const;
    runWithMessageContext(ctx, () => {
      expect(getMessageContext()).toEqual(ctx);
    });
  });

  it("isolates nested contexts", () => {
    runWithMessageContext({ transport: "a", channelKey: "1", agentId: "x" }, () => {
      runWithMessageContext({ transport: "b", channelKey: "2", agentId: "y" }, () => {
        expect(getMessageContext()?.transport).toBe("b");
      });
      expect(getMessageContext()?.transport).toBe("a");
    });
  });

  it("propagates across awaits", async () => {
    const ctx = { transport: "http", channelKey: "s", agentId: "bot" } as const;
    await runWithMessageContext(ctx, async () => {
      await Promise.resolve();
      expect(getMessageContext()).toEqual(ctx);
    });
  });
});
