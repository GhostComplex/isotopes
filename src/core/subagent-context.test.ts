// src/core/subagent-context.test.ts — Tests for subagent Discord context
import { describe, it, expect, vi } from "vitest";
import {
  runWithSubagentContext,
  runWithSubagentContextAsync,
  getSubagentContext,
  hasSubagentContext,
  type SubagentDiscordContext,
} from "./subagent-context.js";

describe("SubagentContext", () => {
  const mockContext: SubagentDiscordContext = {
    sendMessage: vi.fn().mockResolvedValue({ id: "msg-123" }),
    createThread: vi.fn().mockResolvedValue({ id: "thread-456" }),
    channelId: "channel-789",
    showToolCalls: true,
  };

  describe("runWithSubagentContext", () => {
    it("provides context within the callback", () => {
      runWithSubagentContext(mockContext, () => {
        expect(hasSubagentContext()).toBe(true);
        const ctx = getSubagentContext();
        expect(ctx).toBeDefined();
        expect(ctx?.channelId).toBe("channel-789");
        expect(ctx?.showToolCalls).toBe(true);
      });
    });

    it("returns undefined outside the context", () => {
      expect(hasSubagentContext()).toBe(false);
      expect(getSubagentContext()).toBeUndefined();
    });

    it("returns the result of the callback", () => {
      const result = runWithSubagentContext(mockContext, () => {
        return "hello";
      });
      expect(result).toBe("hello");
    });
  });

  describe("runWithSubagentContextAsync", () => {
    it("provides context within async callback", async () => {
      await runWithSubagentContextAsync(mockContext, async () => {
        expect(hasSubagentContext()).toBe(true);
        const ctx = getSubagentContext();
        expect(ctx).toBeDefined();
        expect(ctx?.channelId).toBe("channel-789");
      });
    });

    it("returns the result of the async callback", async () => {
      const result = await runWithSubagentContextAsync(mockContext, async () => {
        return "async-result";
      });
      expect(result).toBe("async-result");
    });

    it("context is available in nested async calls", async () => {
      await runWithSubagentContextAsync(mockContext, async () => {
        const nestedCheck = async () => {
          return hasSubagentContext();
        };
        const hasContext = await nestedCheck();
        expect(hasContext).toBe(true);
      });
    });
  });

  describe("nested contexts", () => {
    it("inner context overrides outer context", () => {
      const innerContext: SubagentDiscordContext = {
        ...mockContext,
        channelId: "inner-channel",
      };

      runWithSubagentContext(mockContext, () => {
        expect(getSubagentContext()?.channelId).toBe("channel-789");

        runWithSubagentContext(innerContext, () => {
          expect(getSubagentContext()?.channelId).toBe("inner-channel");
        });

        // Back to outer context
        expect(getSubagentContext()?.channelId).toBe("channel-789");
      });
    });
  });
});
