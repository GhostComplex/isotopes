// src/core/context.test.ts — Tests for prompt preparation transforms

import { describe, it, expect } from "vitest";
import type { AgentMessage as Message } from "@mariozechner/pi-agent-core";
import { msgField } from "./messages.js";
import {
  pruneImages,
} from "./context.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TS = 1000;
const user = (text: string): Message => ({ role: "user", content: text, timestamp: TS } as unknown as Message);
const assistant = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }], timestamp: TS } as unknown as Message);

// ---------------------------------------------------------------------------
// pruneImages
// ---------------------------------------------------------------------------

describe("pruneImages", () => {
  it("replaces old image blocks with text placeholder", () => {
    const imageBlock = { type: "image", data: "base64..." };
    const msgs: Message[] = [
      { role: "user", content: [imageBlock, { type: "text", text: "look" }], timestamp: Date.now() } as unknown as Message,
      assistant("nice"),
      user("more recent 1"), assistant("r1"),
      user("more recent 2"), assistant("r2"),
      user("more recent 3"), assistant("r3"),
    ];
    const result = pruneImages(msgs, { keepRecentTurns: 3 });
    const content = msgField(result[0], "content") as Array<{type: string; text?: string}>;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("image data removed");
  });

  it("preserves images in recent turns", () => {
    const imageBlock = { type: "image", data: "base64..." };
    const msgs: Message[] = [
      { role: "user", content: [imageBlock], timestamp: Date.now() } as unknown as Message,
      assistant("nice"),
    ];
    const result = pruneImages(msgs, { keepRecentTurns: 3 });
    const content = msgField(result[0], "content") as Array<{type: string}>;
    expect(content[0].type).toBe("image");
  });

  it("no-op when no image blocks exist", () => {
    const msgs = [user("a"), assistant("b")];
    expect(pruneImages(msgs)).toEqual(msgs);
  });
});

