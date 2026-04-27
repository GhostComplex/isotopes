// src/core/spawn-agent-context.test.ts — Tests for spawn agent stream context
import { describe, it, expect, vi } from "vitest";
import {
  runWithSpawnAgentContext,
  runWithSpawnAgentContextAsync,
  getSpawnAgentContext,
  hasSpawnAgentContext,
  type SpawnAgentStreamContext,
} from "./spawn-agent-context.js";

describe("SpawnAgentContext", () => {
  const mockContext: SpawnAgentStreamContext = {
    createSink: vi.fn(),
    channelId: "channel-789",
    showToolCalls: true,
  };

  describe("runWithSpawnAgentContext", () => {
    it("provides context within the callback", () => {
      runWithSpawnAgentContext(mockContext, () => {
        expect(hasSpawnAgentContext()).toBe(true);
        const ctx = getSpawnAgentContext();
        expect(ctx).toBeDefined();
        expect(ctx?.channelId).toBe("channel-789");
        expect(ctx?.showToolCalls).toBe(true);
      });
    });

    it("returns undefined outside the context", () => {
      expect(hasSpawnAgentContext()).toBe(false);
      expect(getSpawnAgentContext()).toBeUndefined();
    });

    it("returns the result of the callback", () => {
      const result = runWithSpawnAgentContext(mockContext, () => {
        return "hello";
      });
      expect(result).toBe("hello");
    });
  });

  describe("runWithSpawnAgentContextAsync", () => {
    it("provides context within async callback", async () => {
      await runWithSpawnAgentContextAsync(mockContext, async () => {
        expect(hasSpawnAgentContext()).toBe(true);
        const ctx = getSpawnAgentContext();
        expect(ctx).toBeDefined();
        expect(ctx?.channelId).toBe("channel-789");
      });
    });

    it("returns the result of the async callback", async () => {
      const result = await runWithSpawnAgentContextAsync(mockContext, async () => {
        return "async-result";
      });
      expect(result).toBe("async-result");
    });

    it("context is available in nested async calls", async () => {
      await runWithSpawnAgentContextAsync(mockContext, async () => {
        const nestedCheck = async () => {
          return hasSpawnAgentContext();
        };
        const hasContext = await nestedCheck();
        expect(hasContext).toBe(true);
      });
    });
  });

  describe("nested contexts", () => {
    it("inner context overrides outer context", () => {
      const innerContext: SpawnAgentStreamContext = {
        ...mockContext,
        channelId: "inner-channel",
      };

      runWithSpawnAgentContext(mockContext, () => {
        expect(getSpawnAgentContext()?.channelId).toBe("channel-789");

        runWithSpawnAgentContext(innerContext, () => {
          expect(getSpawnAgentContext()?.channelId).toBe("inner-channel");
        });

        // Back to outer context
        expect(getSpawnAgentContext()?.channelId).toBe("channel-789");
      });
    });
  });
});
