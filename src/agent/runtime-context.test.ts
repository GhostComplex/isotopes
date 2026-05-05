import { describe, it, expect } from "vitest";
import { runWithRuntimeContext, getRuntimeContext } from "./runtime-context.js";

describe("RuntimeContext AsyncLocalStorage", () => {
  it("returns undefined when not set", () => {
    expect(getRuntimeContext()).toBeUndefined();
  });

  it("propagates context inside the callback", () => {
    const ctx = { parentSessionId: "session-1" };
    runWithRuntimeContext(ctx, () => {
      expect(getRuntimeContext()).toEqual(ctx);
    });
  });

  it("isolates nested contexts", () => {
    runWithRuntimeContext({ parentSessionId: "outer" }, () => {
      runWithRuntimeContext({ parentSessionId: "inner" }, () => {
        expect(getRuntimeContext()?.parentSessionId).toBe("inner");
      });
      expect(getRuntimeContext()?.parentSessionId).toBe("outer");
    });
  });

  it("propagates across awaits", async () => {
    const ctx = { parentSessionId: "async-session" };
    await runWithRuntimeContext(ctx, async () => {
      await Promise.resolve();
      expect(getRuntimeContext()).toEqual(ctx);
    });
  });
});
